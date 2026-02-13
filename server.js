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

/**
 * Validate Token
 * POST /api/tokens/validate
 */
app.post("/api/tokens/validate", async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: "Token is required" });
    }

    const existingToken = await Token.findOne({ token });

    if (!existingToken) {
      return res.status(400).json({ message: "Invalid token" });
    }

    if (existingToken.used) {
      return res.status(400).json({ message: "Token already used" });
    }

    res.json({ message: "Token valid" });

  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

/**
 * Submit Assignment
 * POST /api/submissions
 */
app.post("/api/submissions", upload.single("file"), async (req, res) => {
  try {
    const { name, department, course, phone, email, token } = req.body;

    if (!req.file) {
      return res.status(400).json({ message: "File is required" });
    }

    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc || tokenDoc.used) {
      return res.status(400).json({ message: "Invalid or used token" });
    }

    /* Upload file to Cloudinary (RAW) */
    const uploadResult = await new Promise((resolve, reject) => {
      cloudinary.uploader.upload_stream(
        {
          resource_type: "raw",
          folder: "assignments",
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
      fileUrl: uploadResult.secure_url,
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

/* ---------- HEALTH CHECK ---------- */
app.get("/", (req, res) => {
  res.send("Assignment Submission API running");
});

/* ---------- SERVER ---------- */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});