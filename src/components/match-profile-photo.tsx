'use client';

import { useState } from 'react';
import { Avatar } from '../../packages/payment-chat-ui/src/ui';

export function MatchProfilePhoto({ nickname, photoUrl }: { nickname: string; photoUrl: string | null }) {
  return <div className="campus-profile-photo">{photoUrl
    ? <ProfilePhoto key={photoUrl} nickname={nickname} photoUrl={photoUrl} />
    : <Avatar name={nickname} />}</div>;
}

function ProfilePhoto({ nickname, photoUrl }: { nickname: string; photoUrl: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Avatar name={nickname} />;
  // Signed private-bucket URLs are fetched directly, without caching via an image proxy.
  return <>
    {/* eslint-disable-next-line @next/next/no-img-element -- expiring signed URL, no image proxy cache */}
    <img src={photoUrl} alt={`${nickname} 프로필 사진`} width={240} height={240}
      loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  </>;
}
