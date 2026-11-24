/** Server infrastructure only. The runtime remains disconnected until rollout is reviewed. */
import { createHash } from 'node:crypto';
import type { GroblePaymentEvent } from './groble-events';
import { createPostgresUnitOfWork, type TransactionPool, type PostgresRepositoryOptions } from './postgres-repository';
import { createPostgresTransaction } from './postgres-transaction';
import { applyCompletedPayment, ServiceError } from '../../packages/payment-chat/src/service';

const conflict = (): never => { throw new ServiceError('INVALID_WEBHOOK', '결제 이벤트 식별자가 기존 기록과 일치하지 않습니다.'); };
export interface GrobleInboxResult {
  eventId: string;
  state: 'pending_mapping' | 'applied' | 'review_required';
  orderId: string | null;
}

export function createGrobleInbox(options: {
  pool: TransactionPool;
  verify: (raw: Uint8Array, headers: Headers) => Promise<GroblePaymentEvent>;
  transaction?: PostgresRepositoryOptions;
}) {
  const database = createPostgresUnitOfWork(options.pool, executor => executor, options.transaction);
  return {
    async receive(raw: Uint8Array, headers: Headers): Promise<GrobleInboxResult> {
      // Authentication precedes both JSON interpretation and the first SQL statement.
      const event = await options.verify(raw, headers);
      const { eventId, idempotencyKey, ...business } = event;
      const payloadHash = createHash('sha256').update(JSON.stringify({ ...business,
        occurredAt: new Date(event.occurredAt).toISOString(),
        ...(event.type === 'payment.cancel_requested' ? { requestedAt: new Date(event.requestedAt).toISOString() } : {}),
      })).digest('hex');
      return database.transaction(async q => {
        // Serialize one payment's lifecycle; SERIALIZABLE retry handles a stale concurrent snapshot.
        await q.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [event.transactionId]);
        const previous = (await q.query('select payload_hash from private.groble_events where event_id=$1 for update', [eventId])).rows[0] as {payload_hash: string} | undefined;
        if (previous && previous.payload_hash !== payloadHash) conflict();
        if (!previous) await q.query(`insert into private.groble_events(event_id,transaction_id,event_type,occurred_at,payload_hash)
          values($1,$2,$3,$4,$5)`, [eventId,event.transactionId,event.type,event.occurredAt,payloadHash]);
        const delivery = (await q.query('select event_id from private.groble_deliveries where idempotency_key=$1', [idempotencyKey])).rows[0] as {event_id: string} | undefined;
        if (delivery && delivery.event_id !== eventId) conflict();
        if (!delivery) await q.query('insert into private.groble_deliveries(idempotency_key,event_id) values($1,$2)', [idempotencyKey,eventId]);

        const tx = createPostgresTransaction(q);
        if (event.type === 'payment.completed') {
          await applyCompletedPayment(tx, { reference:event.reference,transactionId:event.transactionId,
            productId:event.productId,amount:event.amount,currency:event.currency }, event.productId);
        }
        if (event.type === 'payment.refunded') {
          const old = (await q.query('select amount,partial_refund from private.groble_refunds where business_key=$1',
            [event.refundDeduplicationKey])).rows[0] as {amount: number; partial_refund: boolean} | undefined;
          if (old && (old.amount !== event.refundAmount || old.partial_refund !== event.partialRefund)) conflict();
          if (!old) await q.query(`insert into private.groble_refunds(business_key,transaction_id,amount,partial_refund,refunded_at)
            values($1,$2,$3,$4,$5)`, [event.refundDeduplicationKey,event.transactionId,event.refundAmount,event.partialRefund,event.refundedAt]);
        }
        const orderId = await tx.paymentOrder(event.transactionId);
        if (orderId) {
          const order = await tx.order(orderId);
          if (!order) throw new Error('Payment order is missing');
          const totals = (await q.query('select coalesce(sum(amount),0)::integer amount from private.groble_refunds where transaction_id=$1',
            [event.transactionId])).rows[0] as {amount: number};
          // Partial/over-total refunds need policy review; do not invent entitlement changes.
          const review = totals.amount > 0 && totals.amount !== order.amountKrw;
          if (totals.amount >= order.amountKrw && ['fulfilled','refund_pending'].includes(order.status))
            await tx.saveOrder({...order,status:'refunded'});
          await q.query(`update private.groble_events set order_id=$2,
            state=case when event_type='payment.refunded' and $3 then 'review_required' else 'applied' end
            where transaction_id=$1`, [event.transactionId,orderId,review]);
        }
        const result = (await q.query('select event_id as "eventId",state,order_id as "orderId" from private.groble_events where event_id=$1', [eventId])).rows[0];
        return result as GrobleInboxResult;
      });
    },
  };
}
