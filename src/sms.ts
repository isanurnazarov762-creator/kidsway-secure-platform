// Sending SMS. With no provider configured, nothing is sent (development: the code is shown on screen instead).
// Twilio is supported through its REST API with plain fetch, so no SDK package is needed.
// Set SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.
// Note: not tested against a live Twilio account in this repository.

export type SmsSender = (to: string, text: string) => Promise<boolean>;

export function makeSmsSender(env: NodeJS.ProcessEnv = process.env): SmsSender {
  if (env.SMS_PROVIDER === "twilio") {
    const sid = env.TWILIO_ACCOUNT_SID || "", token = env.TWILIO_AUTH_TOKEN || "", from = env.TWILIO_FROM || "";
    if (!/^AC[0-9a-f]{32}$/.test(sid) || !token || !from) throw new Error("Twilio is selected but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM is missing");
    return async (to, text) => {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
        signal: AbortSignal.timeout(8000)
      });
      return res.ok;
    };
  }
  return async () => false; // no provider: the caller decides what to do (dev shows the code on screen)
}
