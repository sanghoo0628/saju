/** 로컬 데모 전용. 운영 UI에서는 이 함수를 import하지 않는다. */
export async function demoAction<T = unknown>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetch(`/api/demo/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.message ?? "데모를 실행하지 못했습니다.");
  return result as T;
}
