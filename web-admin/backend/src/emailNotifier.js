// Sends the "your show/movie has been downloaded and is ready to copy to
// deepthought" email -- fires as soon as neuromancer's Radarr/Sonarr imports
// it and Seerr marks it available. deepthought is a pure receiver with no
// visibility into neuromancer, so this is the cue for the person to go
// trigger the copy themselves from deepthought's Media Staging panel.
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
      ? `${title} — Season ${season} is downloaded`
      : `${title} is downloaded`;
  await transport.sendMail({
    from: await fromAddress(),
    to: toEmail,
    subject: `${subject} and ready to copy`,
    text: `${subject} and ready to copy to deepthought via the Media Staging panel.`,
  });
  return { ok: true };
}
