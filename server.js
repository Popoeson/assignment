require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const axios = require("axios");

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

/* ---------- DB CONNECTION ---------- */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

/* ---------- SCHEMAS ---------- */
const tokenSchema = new mongoose.Schema({
  token: { type: String, unique: true },
  used: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const submissionSchema = new mongoose.Schema({
  name: String,
  department: String,
  course: String,
  phone: String,
  email: String,

  files: [
    {
      fileUrl: String,
      fileName: String
    }
  ],

  fileCount: Number,
  amountPaid: Number,
  paymentRef: String,
  score: Number,

  token: String,
  submittedAt: { type: Date, default: Date.now }
});

const Token = mongoose.model("Token", tokenSchema);
const Submission = mongoose.model("Submission", submissionSchema);

/* ---------- MULTER ---------- */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB per file
});

/* ---------- TOKEN VALIDATION ---------- */
app.post("/api/tokens/validate", async (req, res) => {
  const { token } = req.body;
  const found = await Token.findOne({ token });
  if (!found) return res.status(400).json({ message: "Invalid token" });
  if (found.used) return res.status(400).json({ message: "Token already used" });
  res.json({ message: "Token valid" });
});

/* ---------- PAYSTACK VERIFY ---------- */
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference, expectedAmount } = req.body;

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const data = response.data.data;

    if (data.status !== "success")
      return res.status(400).json({ message: "Payment not successful" });

    if (data.amount !== expectedAmount * 100)
      return res.status(400).json({ message: "Amount mismatch" });

    res.json({ verified: true });
  } catch (err) {
    res.status(500).json({ message: "Payment verification failed" });
  }
});

/* ---------- SUBMISSION ---------- */
app.post("/api/submissions", upload.array("files", 5), async (req, res) => {
  try {
    const { name, department, course, phone, email, token, paymentRef } = req.body;

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ message: "No files uploaded" });

    const tokenDoc = await Token.findOne({ token });
    if (!tokenDoc || tokenDoc.used)
      return res.status(400).json({ message: "Invalid or used token" });

    const fileCount = req.files.length;
    const amountPaid = fileCount * 200;

    /* Upload all files */
    const uploadedFiles = [];

    for (const file of req.files) {
      const uploadResult = await new Promise((resolve, reject) => {
        cloudinary.uploader.upload_stream(
          {
            resource_type: "raw",
            folder: "assignments",
            use_filename: true,
            unique_filename: true
          },
          (err, result) => (err ? reject(err) : resolve(result))
        ).end(file.buffer);
      });

      uploadedFiles.push({
        fileUrl: uploadResult.secure_url,
        fileName: file.originalname
      });
    }

    const score = Math.floor(Math.random() * (19 - 13 + 1)) + 13;

    await Submission.create({
      name,
      department,
      course,
      phone,
      email,
      files: uploadedFiles,
      fileCount,
      amountPaid,
      paymentRef,
      score,
      token
    });

    tokenDoc.used = true;
    await tokenDoc.save();

    res.json({
      message: "Submission successful",
      score
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Submission failed" });
  }
});

/* ---------- ADMIN ---------- */
app.get("/api/submissions", async (_, res) => {
  const submissions = await Submission.find().sort({ submittedAt: -1 });
  res.json(submissions);
});

/* ---------- TOKENS ---------- */
app.get("/api/tokens", async (_, res) => {
  res.json(await Token.find().sort({ createdAt: -1 }));
});

app.post("/api/tokens/generate", async (req, res) => {
  const { amount } = req.body;
  const tokens = [];

  for (let i = 0; i < amount; i++) {
    tokens.push(await Token.create({
      token: `ICT-${Math.random().toString(36).substr(2, 8).toUpperCase()}`
    }));
  }

  res.json(tokens);
});

/* ---------- SERVER ---------- */
app.listen(process.env.PORT || 5000, () =>
  console.log("🚀 Server running")
);