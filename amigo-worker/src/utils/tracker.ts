let subrequestsCount = 0;
let subrequestsLimit = 9000;

export function resetSubrequestsCount(limit = 9000): void {
  subrequestsCount = 0;
  subrequestsLimit = limit;
}

export function getSubrequestsCount(): number {
  return subrequestsCount;
}

export function checkSubrequestsCapacity(required = 1): void {
  if (subrequestsCount + required > subrequestsLimit) {
    throw new Error("SUBREQUESTS_LIMIT_EXCEEDED");
  }
}

export async function trackedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  checkSubrequestsCapacity(1);
  subrequestsCount++;
  console.log(`[Subrequest Tracker] Fetch #${subrequestsCount}: ${typeof input === "string" ? input.substring(0, 80) : input.toString().substring(0, 80)}`);
  return fetch(input, init);
}
