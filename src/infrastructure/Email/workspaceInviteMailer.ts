import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../Config/env.js';

interface SendWorkspaceInvitationEmailInput {
  toEmail: string;
  recipientName?: string;
  inviterName: string;
  inviteCode: string;
  signUpUrl: string;
  signInUrl: string;
}

const hasInviteMailConfig = Boolean(
  env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.SMTP_FROM,
);

let transporter: Transporter | null = null;

const getTransporter = (): Transporter => {
  if (transporter) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  return transporter;
};

export const canSendWorkspaceInvitationEmails = (): boolean => hasInviteMailConfig;

export const sendWorkspaceInvitationEmail = async (
  input: SendWorkspaceInvitationEmailInput,
): Promise<void> => {
  if (!hasInviteMailConfig) {
    throw new Error('SMTP invite email is not configured.');
  }

  const greeting = input.recipientName ? `Hi ${input.recipientName},` : 'Hi,';
  const subject = `${input.inviterName} invited you to join Project Mirror`;
  const text = [
    greeting,
    '',
    `${input.inviterName} invited you to join a shared Project Mirror workspace.`,
    'You can create an account or sign in with the links below and the invite code will already be attached.',
    '',
    `Create account: ${input.signUpUrl}`,
    `Sign in: ${input.signInUrl}`,
    '',
    `Invite code: ${input.inviteCode}`,
    '',
    'If the link opens on another device, you can still join manually by entering the invite code after signing in.',
    '',
    'Project Mirror',
  ].join('\n');

  const html = `
    <div style="background:#f4efdf;padding:32px 20px;font-family:'Segoe UI',Arial,sans-serif;color:#333333;">
      <div style="max-width:640px;margin:0 auto;background:#fbf8ef;border:1px solid rgba(109,98,70,0.12);border-radius:28px;padding:32px;">
        <p style="margin:0 0 12px;font-size:12px;letter-spacing:0.22em;text-transform:uppercase;color:#7d7a63;">
          Project Mirror
        </p>
        <h1 style="margin:0 0 20px;font-size:30px;line-height:1.2;font-weight:600;color:#2f342d;">
          ${input.inviterName} invited you into a shared workspace
        </h1>
        <p style="margin:0 0 18px;font-size:16px;line-height:1.8;color:#485046;">
          ${greeting.replace(',', '')}, Project Mirror uses one workspace for both partners so your sessions, summaries, and next steps stay together.
        </p>
        <p style="margin:0 0 24px;font-size:16px;line-height:1.8;color:#485046;">
          Choose the path that fits best. The invite code is already included in both links.
        </p>
        <div style="margin:0 0 16px;">
          <a href="${input.signUpUrl}" style="display:inline-block;background:#d9927b;color:#ffffff;text-decoration:none;border-radius:999px;padding:14px 22px;font-weight:600;margin-right:12px;margin-bottom:12px;">
            Start your journey
          </a>
          <a href="${input.signInUrl}" style="display:inline-block;background:#6f8fad;color:#ffffff;text-decoration:none;border-radius:999px;padding:14px 22px;font-weight:600;margin-bottom:12px;">
            I already have an account
          </a>
        </div>
        <div style="margin:24px 0;padding:18px 20px;border-radius:22px;background:#ebe5d0;">
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:#7d7a63;">
            Manual fallback
          </p>
          <p style="margin:0;font-size:16px;line-height:1.7;color:#2f342d;">
            Invite code: <strong>${input.inviteCode}</strong>
          </p>
        </div>
        <p style="margin:0;font-size:14px;line-height:1.7;color:#667062;">
          If the button opens on a different device, sign in first and then paste the invite code into the join workspace form.
        </p>
      </div>
    </div>
  `;

  await getTransporter().sendMail({
    from: env.SMTP_FROM,
    to: input.toEmail,
    subject,
    text,
    html,
  });
};
