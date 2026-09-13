// Sends the "your show/movie is ready to watch on deepthought" email.
//
// This host already runs a local Postfix relaying outbound mail through
// Fastmail (/etc/postfix/main.cf: relayhost = [smtp.fastmail.com]:587, SASL
// creds already configured there) — every other cron job/script on the box
// just hands mail to localhost:25 and Postfix does the rest. No new SMTP
// credentials, no Infisical secret, nothing to configure beyond a from
// address.

import nodemailer from "nodemailer";
import { getUserConfig } from "./configRegistry.js";

async function fromAddress() {
  const config = await getUserConfig();
  return config?.seerrNotify?.from_address || "recon@localhost";
}

export async function sendReadyEmail({ toEmail, title, season }) {
  if (!toEmail) return { ok: false, error: "no recipient email" };
  const transport = nodemailer.createTransport({
    host: "localhost",
    port: 25,
    // Loopback submission to our own Postfix — skip STARTTLS rather than
    // choke on its self-signed snakeoil cert; the encrypted hop to Fastmail
    // happens on Postfix's side of this handoff, not ours.
    ignoreTLS: true,
  });
  const subject =
    season != null
      ? `${title} — Season ${season} is ready`
      : `${title} is ready`;
  await transport.sendMail({
    from: await fromAddress(),
    to: toEmail,
    subject: `${subject} to watch`,
    text: `${subject} to watch on deepthought.`,
  });
  return { ok: true };
}
