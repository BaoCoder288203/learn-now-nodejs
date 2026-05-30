import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import dns from "dns/promises";
import { prisma } from "../db.js";
import { redis } from "../lib/redis.js";
import { sendOtpEmail } from "../lib/mailer.js";

const JWT_SECRET = process.env.JWT_SECRET || "toeic_secret_access_token_key_2026";
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "toeic_secret_refresh_token_key_2026";

const OTP_TTL = 300; // 5 minutes
const OTP_COOLDOWN = 60; // 1 minute between resends

function generateOtp(): string {
  return crypto.randomInt(100000, 999999).toString();
}

async function isEmailDomainValid(email: string): Promise<boolean> {
  const domain = email.split("@")[1];
  if (!domain) return false;
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

export async function requestOtp(req: Request, res: Response): Promise<void> {
  const { email, name, password, confirmPassword, dateOfBirth, gender } = req.body;

  if (!email || !name || !password || !confirmPassword) {
    res.status(400).json({ error: "Vui lòng điền đầy đủ thông tin bắt buộc." });
    return;
  }

  if (password !== confirmPassword) {
    res.status(400).json({ error: "Mật khẩu xác nhận không khớp." });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: "Mật khẩu phải có ít nhất 6 ký tự." });
    return;
  }

  const domainValid = await isEmailDomainValid(email);
  if (!domainValid) {
    res.status(400).json({ error: "Email không hợp lệ hoặc tên miền không tồn tại." });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ error: "Email này đã được đăng ký." });
      return;
    }

    const cooldownKey = `otp_cooldown:${email}`;
    const hasCooldown = await redis.get(cooldownKey);
    if (hasCooldown) {
      res.status(429).json({ error: "Vui lòng chờ 60 giây trước khi gửi lại mã OTP." });
      return;
    }

    const otp = generateOtp();
    const hashedPassword = await bcrypt.hash(password, 10);

    const pendingData = JSON.stringify({
      email,
      name,
      password: hashedPassword,
      dateOfBirth: dateOfBirth || null,
      gender: gender || null,
    });

    await redis.setex(`otp:${email}`, OTP_TTL, otp);
    await redis.setex(`pending_user:${email}`, OTP_TTL, pendingData);
    await redis.setex(cooldownKey, OTP_COOLDOWN, "1");

    await sendOtpEmail(email, otp);

    res.json({ message: "Mã OTP đã được gửi đến email của bạn." });
  } catch (error) {
    console.error("Request OTP error:", error);
    res.status(500).json({ error: "Không thể gửi mã OTP. Vui lòng thử lại sau." });
  }
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { email, otp } = req.body;

  if (!email || !otp) {
    res.status(400).json({ error: "Vui lòng nhập email và mã OTP." });
    return;
  }

  try {
    const storedOtp = await redis.get(`otp:${email}`);
    if (!storedOtp) {
      res.status(400).json({ error: "Mã OTP đã hết hạn. Vui lòng yêu cầu mã mới." });
      return;
    }

    if (storedOtp !== otp.toString()) {
      res.status(400).json({ error: "Mã OTP không chính xác." });
      return;
    }

    const pendingData = await redis.get(`pending_user:${email}`);
    if (!pendingData) {
      res.status(400).json({ error: "Thông tin đăng ký đã hết hạn. Vui lòng đăng ký lại." });
      return;
    }

    const userData = JSON.parse(pendingData);

    const user = await prisma.user.create({
      data: {
        email: userData.email,
        password: userData.password,
        name: userData.name,
        dateOfBirth: userData.dateOfBirth ? new Date(userData.dateOfBirth) : null,
        gender: userData.gender,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    await redis.del(`otp:${email}`, `pending_user:${email}`, `otp_cooldown:${email}`);

    res.status(201).json({ message: "Đăng ký thành công!", user });
  } catch (error: any) {
    if (error.code === "P2002") {
      res.status(400).json({ error: "Email này đã được đăng ký." });
      return;
    }
    console.error("Verify OTP error:", error);
    res.status(500).json({ error: "Đăng ký thất bại. Vui lòng thử lại." });
  }
}

export async function register(req: Request, res: Response): Promise<void> {
  const { email, password, name, role } = req.body;

  if (!email || !password || !name) {
    res.status(400).json({ error: "Missing required fields (email, password, name)" });
    return;
  }

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ error: "Email is already registered" });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const userRole = role === "ADMIN" ? "ADMIN" : "USER";

    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        role: userRole,
      },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
      },
    });

    res.status(201).json({ message: "Registration successful", user });
  } catch (error) {
    console.error("Register error:", error);
    res.status(500).json({ error: "Registration failed due to database error." });
  }
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      res.status(400).json({ error: "Invalid email or password" });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(400).json({ error: "Invalid email or password" });
      return;
    }

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "4h" }
    );

    const refreshToken = jwt.sign(
      { id: user.id },
      JWT_REFRESH_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Login successful",
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({ error: "Refresh token is required" });
    return;
  }

  try {
    const decoded = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as { id: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.id } });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const accessToken = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: "4h" }
    );

    res.json({ accessToken });
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
  }
}
