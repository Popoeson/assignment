require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;

const app = express();

/* ---------- MIDDLEWARE ---------- */
app.use(cors());
app.use(express.json());

/* ---------- CLOUDINARY CONFIG ---------- */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/* ---------- MONGODB CONNECTION ---------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

/* ---------- SCHEMAS ---------- */

// Token Schema
const tokenSchema = new mongoose.Schema({
  token: { type: String, unique: true },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

// Submission Schema
const submissionSchema = new mongoose.Schema({
  name: String,
  department: String,
  course: String,
  phone: String,
  email: String,
  fileUrl: String,
  fileName: String,
  token: String,
  submittedAt: { type: Date, default: Date.now }
});

const Token = mongoose.model("Token", tokenSchema);
const Submission = mongoose.model("Submission", submissionSchema);

/* ---------- MULTER SETUP ---------- */
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

/* ---------- ROUTES ---------- */

/* ---------- STUDENT ROUTES ---------- */

// Validate Token
app.post("/api/tokens/validate", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "Token is required" });

    const existingToken = await Token.findOne({ token });
    if (!existingToken) return res.status(400).json({ message: "Invalid token" });
    if (existingToken.used) return res.status(400).json({ message: "Token already used" });

    res.json({ message: "Token valid" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

/* ---------- SUBMIT ASSIGNMENT ---------- */
app.post("/api/submissions", upload.single("file"), async (req, res) => {
  try {
    const { name, department, course, phone, email, token } = req.body;

    if (!req.file) return res.status(400).json({ message: "File is required" });

    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc || tokenDoc.used) return res.status(400).json({ message: "Invalid or used token" });

    /* Upload file to Cloudinary (RAW) with original filename and extension */
    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: "raw",
          folder: "assignments",
          use_filename: true,       // preserves original file name
          unique_filename: false,   // avoids random renaming
          overwrite: false
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      ).end(req.file.buffer);
    });

    /* Save submission */
    await Submission.create({
      name,
      department,
      course,
      phone,
      email,
      fileUrl: uploadResult.secure_url, // now includes filename + extension
      fileName: req.file.originalname,
      token
    });

    /* Mark token as used */
    tokenDoc.used = true;
    await tokenDoc.save();

    res.json({ message: "Assignment submitted successfully" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Submission failed" });
  }
});

/* ---------- ADMIN ROUTES ---------- */

// Get all submissions
app.get("/api/submissions", async (req, res) => {
  try {
    const submissions = await Submission.find().sort({ submittedAt: -1 });
    res.json(submissions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch submissions" });
  }
});

// Get all tokens
app.get("/api/tokens", async (req, res) => {
  try {
    const tokens = await Token.find().sort({ createdAt: -1 });
    res.json(tokens);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch tokens" });
  }
});

// Generate tokens
app.post("/api/tokens/generate", async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid amount" });

    const newTokens = [];
    for (let i = 0; i < amount; i++) {
      const tokenStr = `ICT-${Math.random().toString(36).substr(2, 8).toUpperCase()}`;
      const tokenDoc = await Token.create({ token: tokenStr });
      newTokens.push(tokenDoc);
    }

    res.json(newTokens);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Token generation failed" });
  }
});

/* ---------- HEALTH CHECK ---------- */
app.get("/", (req, res) => {
  res.send("Assignment Submission API running");
});

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});