require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const twilio = require("twilio");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Twilio & Email clients ───────────────────
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const mailer = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// ─── Rate limiter for auth routes ────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: "Too many attempts. Try again in 15 minutes." }
});

// ─── JWT middleware ───────────────────────────
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Not authenticated" });
  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Session expired. Please login again." });
  }
}

// ─── OTP helper ──────────────────────────────
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendEmailOTP(email, otp, name) {
  await mailer.sendMail({
    from: `"GlamUp" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Your GlamUp Verification Code",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#fff;">
        <h2 style="color:#C8185C;font-family:Georgia,serif;">GlamUp ✦</h2>
        <p>Hi <strong>${name}</strong>,</p>
        <p>Your verification code is:</p>
        <div style="font-size:36px;font-weight:700;letter-spacing:8px;color:#C8185C;
                    text-align:center;padding:20px;background:#fde8f1;border-radius:12px;margin:20px 0;">
          ${otp}
        </div>
        <p style="color:#888;font-size:13px;">This code expires in 10 minutes. Do not share it with anyone.</p>
      </div>`
  });
}

async function sendSMS(phone, message) {
  await twilioClient.messages.create({
    body: message,
    from: process.env.TWILIO_PHONE,
    to: phone
  });
}

// ─── DB: ensure tables exist ─────────────────
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS glamup_users (
      user_id     SERIAL PRIMARY KEY,
      name        VARCHAR(100) NOT NULL,
      email       VARCHAR(150) UNIQUE NOT NULL,
      phone       VARCHAR(20)  UNIQUE NOT NULL,
      password    TEXT NOT NULL,
      is_verified BOOLEAN DEFAULT FALSE,
      otp         VARCHAR(10),
      otp_expires TIMESTAMPTZ,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}
ensureTables().catch(console.error);

// ═══════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════

// REGISTER — step 1: create account, send OTP
app.post("/auth/register", authLimiter, async (req, res) => {
  const { name, email, phone, password, otpMethod } = req.body;

  if (!name || !email || !phone || !password || !otpMethod) {
    return res.status(400).json({ error: "All fields are required." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  try {
    // Check duplicates
    const existing = await pool.query(
      "SELECT user_id FROM glamup_users WHERE email=$1 OR phone=$2",
      [email, phone]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "Email or phone already registered." });
    }

    const hashed = await bcrypt.hash(password, 10);
    const otp = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    await pool.query(
      `INSERT INTO glamup_users (name, email, phone, password, otp, otp_expires)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [name, email, phone, hashed, otp, expires]
    );

    // Send OTP
    if (otpMethod === "email") {
      await sendEmailOTP(email, otp, name);
    } else {
      await sendSMS(phone, `Your GlamUp verification code is: ${otp}. Valid for 10 minutes.`);
    }

    res.json({ message: `OTP sent to your ${otpMethod}.`, otpMethod });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

// VERIFY OTP — step 2: activate account
app.post("/auth/verify-otp", authLimiter, async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: "Email and OTP are required." });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM glamup_users WHERE email=$1", [email]
    );
    const user = result.rows[0];

    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.is_verified) return res.status(400).json({ error: "Account already verified." });
    if (user.otp !== otp) return res.status(400).json({ error: "Incorrect OTP." });
    if (new Date() > new Date(user.otp_expires)) {
      return res.status(400).json({ error: "OTP expired. Please request a new one." });
    }

    await pool.query(
      "UPDATE glamup_users SET is_verified=TRUE, otp=NULL, otp_expires=NULL WHERE email=$1",
      [email]
    );

    const token = jwt.sign(
      { userId: user.user_id, email: user.email, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      message: "Account verified successfully!",
      token,
      user: { name: user.name, email: user.email, phone: user.phone }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Verification failed." });
  }
});

// RESEND OTP
app.post("/auth/resend-otp", authLimiter, async (req, res) => {
  const { email, otpMethod } = req.body;

  try {
    const result = await pool.query(
      "SELECT * FROM glamup_users WHERE email=$1 AND is_verified=FALSE", [email]
    );
    const user = result.rows[0];
    if (!user) return res.status(404).json({ error: "User not found or already verified." });

    const otp = generateOTP();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      "UPDATE glamup_users SET otp=$1, otp_expires=$2 WHERE email=$3",
      [otp, expires, email]
    );

    if (otpMethod === "email") {
      await sendEmailOTP(email, otp, user.name);
    } else {
      await sendSMS(user.phone, `Your new GlamUp code is: ${otp}. Valid for 10 minutes.`);
    }

    res.json({ message: "New OTP sent." });
  } catch (err) {
    res.status(500).json({ error: "Could not resend OTP." });
  }
});

// LOGIN
app.post("/auth/login", authLimiter, async (req, res) => {
  const { identifier, password } = req.body; // identifier = email or phone

  if (!identifier || !password) {
    return res.status(400).json({ error: "Email/phone and password are required." });
  }

  try {
    const result = await pool.query(
      "SELECT * FROM glamup_users WHERE email=$1 OR phone=$1", [identifier]
    );
    const user = result.rows[0];

    if (!user) return res.status(404).json({ error: "Account not found." });
    if (!user.is_verified) {
      return res.status(403).json({ error: "Please verify your account first.", needsVerify: true, email: user.email });
    }

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    const token = jwt.sign(
      { userId: user.user_id, email: user.email, name: user.name, phone: user.phone },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: { userId: user.user_id, name: user.name, email: user.email, phone: user.phone }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

// ═══════════════════════════════════════════════
//  EXISTING ROUTES (unchanged)
// ═══════════════════════════════════════════════

app.get("/", (req, res) => res.json({ status: "GlamUp API running" }));

app.get("/artists", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.artist_id, u.name, a.location, a.rating
      FROM artists a JOIN users u ON a.user_id = u.user_id
      ORDER BY a.rating DESC NULLS LAST
    `);
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Could not fetch artists" }); }
});

app.get("/services/:artistId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM services WHERE artist_id=$1 ORDER BY price ASC",
      [req.params.artistId]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Could not fetch services" }); }
});

app.get("/bookings", async (req, res) => {
  const { artistId, date } = req.query;
  if (!artistId || !date) return res.status(400).json({ error: "artistId and date required" });
  try {
    const result = await pool.query(
      `SELECT booking_time FROM bookings
       WHERE artist_id=$1 AND booking_date=$2 AND status='Booked'`,
      [artistId, date]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Could not fetch slots" }); }
});

app.get("/bookings/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.booking_id, b.booking_date, b.booking_time, b.status,
              s.service_name, s.price
       FROM bookings b JOIN services s ON b.service_id=s.service_id
       WHERE b.user_id=$1
       ORDER BY b.booking_date DESC, b.booking_time DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch { res.status(500).json({ error: "Could not fetch bookings" }); }
});

// BOOK — sends confirmation SMS
app.post("/book", requireAuth, async (req, res) => {
  const { artistId, serviceId, bookingDate, bookingTime } = req.body;
  const userId = req.user.userId;

  if (!artistId || !serviceId || !bookingDate || !bookingTime) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const check = await pool.query(
      `SELECT 1 FROM bookings
       WHERE artist_id=$1 AND booking_date=$2 AND booking_time=$3 AND status='Booked'`,
      [artistId, bookingDate, bookingTime]
    );
    if (check.rows.length > 0) {
      return res.status(409).json({ error: "Slot already booked" });
    }

    await pool.query(
      `INSERT INTO bookings (user_id, artist_id, service_id, booking_date, booking_time)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, artistId, serviceId, bookingDate, bookingTime]
    );

    // Get service name + user phone for SMS
    const serviceRes = await pool.query(
      "SELECT service_name FROM services WHERE service_id=$1", [serviceId]
    );
    const userRes = await pool.query(
      "SELECT phone, name FROM glamup_users WHERE user_id=$1", [userId]
    );

    if (userRes.rows[0]?.phone && serviceRes.rows[0]) {
      const { phone, name } = userRes.rows[0];
      const { service_name } = serviceRes.rows[0];
      await sendSMS(phone,
        `Hi ${name}! Your GlamUp booking is confirmed.\n` +
        `Service: ${service_name}\nDate: ${bookingDate} at ${bookingTime}\n` +
        `See you soon! ✦`
      ).catch(console.error); // non-blocking
    }

    res.status(201).json({ message: "Booking successful" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Booking failed" });
  }
});

// CANCEL — sends cancellation SMS
app.put("/cancel/:bookingId", requireAuth, async (req, res) => {
  const userId = req.user.userId;

  try {
    const bookingRes = await pool.query(
      `SELECT b.booking_date, b.booking_time, s.service_name, gu.phone, gu.name
       FROM bookings b
       JOIN services s ON b.service_id=s.service_id
       JOIN glamup_users gu ON gu.user_id=b.user_id
       WHERE b.booking_id=$1 AND b.user_id=$2`,
      [req.params.bookingId, userId]
    );
    const booking = bookingRes.rows[0];

    await pool.query(
      "UPDATE bookings SET status='Cancelled' WHERE booking_id=$1 AND user_id=$2",
      [req.params.bookingId, userId]
    );

    if (booking?.phone) {
      await sendSMS(booking.phone,
        `Hi ${booking.name}, your GlamUp booking has been cancelled.\n` +
        `Service: ${booking.service_name} on ${booking.booking_date} at ${booking.booking_time.substring(0,5)}.\n` +
        `Book again anytime at GlamUp.`
      ).catch(console.error);
    }

    res.json({ message: "Booking cancelled" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not cancel booking" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`GlamUp API running on port ${PORT}`));