require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // required for Supabase
});

// Root API
app.get("/", (req, res) => {
  res.send("Makeup Booking API Running 🚀");
});

// 🔹 Test DB connection
app.get("/test-db", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 🔹 Get all artists
app.get("/artists", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT a.artist_id, u.name, a.location, a.rating
      FROM artists a
      JOIN users u ON a.user_id = u.user_id
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 🔹 Get services by artist
app.get("/services/:artistId", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM services WHERE artist_id = $1",
      [req.params.artistId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 🔹 Create booking (with validation)
app.post("/book", async (req, res) => {
  try {
    const { userId, artistId, serviceId, bookingDate, bookingTime } = req.body;

    if (!userId || !artistId || !serviceId || !bookingDate || !bookingTime) {
      return res.status(400).send("Missing required fields ❌");
    }

    // Check if slot already booked
    const check = await pool.query(
      `SELECT * FROM bookings
       WHERE artist_id = $1
       AND booking_date = $2
       AND booking_time = $3
       AND status = 'Booked'`,
      [artistId, bookingDate, bookingTime]
    );

    if (check.rows.length > 0) {
      return res.status(400).send("Slot already booked ❌");
    }

    // Insert booking
    await pool.query(
      `INSERT INTO bookings (user_id, artist_id, service_id, booking_date, booking_time)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, artistId, serviceId, bookingDate, bookingTime]
    );

    res.send("Booking successful ✅");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 🔹 Get bookings by user
app.get("/bookings/:userId", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.*, s.service_name, s.price
       FROM bookings b
       JOIN services s ON b.service_id = s.service_id
       WHERE b.user_id = $1`,
      [req.params.userId]
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// 🔹 Cancel booking
app.put("/cancel/:bookingId", async (req, res) => {
  try {
    await pool.query(
      `UPDATE bookings
       SET status = 'Cancelled'
       WHERE booking_id = $1`,
      [req.params.bookingId]
    );

    res.send("Booking cancelled ✅");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Server start
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});