import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.gmail.com",
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function sendOtpEmail(to: string, otp: string): Promise<void> {
  await transporter.sendMail({
    from: `"Learn Now" <${process.env.SMTP_USER}>`,
    to,
    subject: "Mã xác thực OTP - Learn Now",
    html: `
      <div style="font-family: 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 32px; background: #f8fafc; border-radius: 16px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #1e40af; font-size: 24px; margin: 0;">Learn Now</h1>
          <p style="color: #64748b; font-size: 14px; margin-top: 4px;">Xác thực tài khoản</p>
        </div>
        <div style="background: white; padding: 24px; border-radius: 12px; text-align: center; border: 1px solid #e2e8f0;">
          <p style="color: #334155; font-size: 15px; margin: 0 0 16px;">Mã OTP của bạn là:</p>
          <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #2563eb; background: #eff6ff; padding: 16px; border-radius: 8px; font-family: monospace;">
            ${otp}
          </div>
          <p style="color: #94a3b8; font-size: 13px; margin-top: 16px;">Mã có hiệu lực trong <strong>5 phút</strong>. Không chia sẻ mã này với bất kỳ ai.</p>
        </div>
      </div>
    `,
  });
}
