require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Root
app.get("/", (req, res) => res.json({ status: "GlamUp API running" }));

// Test DB
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "DB connection failed" });
  }
});

// Get all artists
app.get("/artists", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.artist_id, u.name, a.location, a.rating
      FROM artists a
      JOIN users u ON a.user_id = u.user_id
      ORDER BY a.rating DESC NULLS LAST
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch artists" });
  }
});

// Get services by artist
app.get("/services/:artistId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM services WHERE artist_id = $1 ORDER BY price ASC",
      [req.params.artistId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch services" });
  }
});

// ✅ FIX: GET /bookings?artistId=&date=  (used by slot availability check)
app.get("/bookings", async (req, res) => {
  const { artistId, date } = req.query;
  if (!artistId || !date) {
    return res.status(400).json({ error: "artistId and date are required" });
  }
  try {
    const result = await pool.query(
      `SELECT booking_time FROM bookings
       WHERE artist_id = $1 AND booking_date = $2 AND status = 'Booked'`,
      [artistId, date]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch bookings" });
  }
});

// GET /bookings/:userId  (my bookings)
app.get("/bookings/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.booking_id, b.booking_date, b.booking_time, b.status,
              s.service_name, s.price
       FROM bookings b
       JOIN services s ON b.service_id = s.service_id
       WHERE b.user_id = $1
       ORDER BY b.booking_date DESC, b.booking_time DESC`,
      [req.params.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch user bookings" });
  }
});

// Create booking
app.post("/book", async (req, res) => {
  const { userId, artistId, serviceId, bookingDate, bookingTime } = req.body;

  if (!userId || !artistId || !serviceId || !bookingDate || !bookingTime) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const check = await pool.query(
      `SELECT 1 FROM bookings
       WHERE artist_id = $1 AND booking_date = $2
         AND booking_time = $3 AND status = 'Booked'`,
      [artistId, bookingDate, bookingTime]
    );

    if (check.rows.length > 0) {
      return res.status(409).json({ error: "Slot already booked" });
    }

    await pool.query(
      `INSERT INTO bookings (user_id, artist_id, service_id, booking_date, booking_time)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, artistId, serviceId, bookingDate, bookingTime]
    );

    res.status(201).json({ message: "Booking successful" });
  } catch (err) {
    res.status(500).json({ error: "Booking failed" });
  }
});

// Cancel booking
app.put("/cancel/:bookingId", async (req, res) => {
  try {
    await pool.query(
      `UPDATE bookings SET status = 'Cancelled' WHERE booking_id = $1`,
      [req.params.bookingId]
    );
    res.json({ message: "Booking cancelled" });
  } catch (err) {
    res.status(500).json({ error: "Could not cancel booking" });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`GlamUp API running on port ${PORT}`));