const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const connectDB = require("../utils/db");
const fs = require("fs");
const path = require("path");

const config = require("../config");
const { broadcastNotification } = require("../utils/notificationEmitter");

const router = express.Router();
const JWT_SECRET = config.JWT_SECRET;
const blogDir = path.join(__dirname, "../public/blogposts");
if (!fs.existsSync(blogDir)) fs.mkdirSync(blogDir, { recursive: true });

// Middleware to protect routes
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access denied" });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

// Register endpoint
router.post("/register", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "Username and password required" });
    }
    const existingUser = await db.collection("users").findOne({ username });
    if (existingUser) {
      return res.status(409).json({ error: "Username already exists" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    await db
      .collection("users")
      .insertOne({ username, password: hashedPassword });
    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login endpoint
router.post("/login", async (req, res) => {
  try {
    const db = await connectDB();
    const { username, password } = req.body;
    console.log("Login attempt for username:", username);
    const user = await db.collection("users").findOne({ username });
    if (!user) {
      console.log("Login failed: User not found");
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const valid = await bcrypt.compare(password, user.password);
    // if (!valid) {
    //   console.log(user);
    //   return res.status(401).json({ error: 'Invalid credentials' });
    // }
    const token = jwt.sign(
      { username: user.username, id: user._id },
      JWT_SECRET,
      { expiresIn: "10h" }
    );
    res.json({ token });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST endpoint to receive data and save to MongoDB (protected)
router.post("/data", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { name, value } = req.body;
    const result = await db.collection("data").insertOne({ name, value });
    res
      .status(201)
      .json({ message: "Data saved successfully", data: result.ops[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/sellData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("sellData").insertOne(doc);
    
    // Broadcast real-time push notification
    broadcastNotification({
      type: "sell",
      title: "New Sell Offer Request",
      message: `${data.name || "A customer"} submitted a sell offer for ${data.deviceBrand || data.deviceName || data.item || "a device"}.`,
      link: "/sell-requests",
      data: { name: data.name, phone: data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/repairData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("repairData").insertOne(doc);

    // Broadcast real-time push notification
    broadcastNotification({
      type: "repair",
      title: "New Remote Repair Request",
      message: `${data.remoteName || data.name || "A customer"} submitted a remote repair request.`,
      link: "/remote-requests",
      data: { name: data.remoteName || data.name, phone: data.remotePhone || data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/bookData", async (req, res) => {
  try {
    const db = await connectDB();
    const data = req.body;
    const doc = { ...data, submittedAt: new Date() };
    const result = await db.collection("bookData").insertOne(doc);

    // Broadcast real-time push notification
    broadcastNotification({
      type: "booking",
      title: "New Booking Request",
      message: `${data.bookName || data.name || "A customer"} submitted a booking request for ${data.bookDevice || data.device || "a repair service"}.`,
      link: "/bookings",
      data: { name: data.bookName || data.name, phone: data.bookPhone || data.phone }
    });

    res.status(201).json({ message: "Data saved successfully", data: result.ops ? result.ops[0] : doc });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/bookData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("bookData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: "viewed" } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.get("/sellData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("sellData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: false } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});
router.get("/repairData/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("repairData").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $set: { new: "viewed" } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ─── Status Update Endpoints ────────────────────────────────
router.patch("/bookData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("bookData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.patch("/sellData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("sellData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

router.patch("/repairData/:id/status", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const db = await connectDB();
    const { status, comment } = req.body;
    if (!status) return res.status(400).json({ error: "Status is required" });
    
    const updateFields = { new: status };
    if (comment !== undefined) {
      updateFields.comment = comment;
    }
    
    const result = await db.collection("repairData").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updateFields },
      { returnDocument: "after" }
    );
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// GET endpoint to fetch all data from MongoDB (protected)
router.get("/data", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("data").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/dashboard-stats", async (req, res) => {
  try {
    const db = await connectDB();
    const book = await db.collection("bookData").find({ new: "new" }).count();
    const sell = await db.collection("sellData").find({ new: "new" }).count();
    const repair = await db
      .collection("repairData")
      .find({ new: "new" })
      .count();
    const subscribers = await db.collection("newsletter_subscribers").countDocuments();
    res.status(200).json({ book, sell, repair, subscribers });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/sellData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("sellData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/repairData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("repairData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// Unauthenticated GET endpoint to fetch all data from MongoDB
router.get("/bookData", async (req, res) => {
  try {
    const db = await connectDB();
    const allData = await db.collection("bookData").find().toArray();
    res.status(200).json(allData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST a blog post (HTML as single text, unauthenticated, save to file)
router.post("/blogpost", async (req, res) => {
  try {
    const db = await connectDB();
    const { html } = req.body;
    if (!html || typeof html !== "string" || !html.trim()) {
      return res.status(400).json({ error: "Blog post HTML content required" });
    }
    const createdAt = new Date();
    const filename = `${createdAt.getTime()}-${Math.round(
      Math.random() * 1e9
    )}.html`;
    const filePath = path.join(blogDir, filename);
    fs.writeFileSync(filePath, html, "utf8");
    const url = `/public/blogposts/${filename}`;
    const doc = { url, createdAt };
    const result = await db.collection("blogposts").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), url, createdAt });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET the latest blog post (HTML stream, unauthenticated, fetch from file)
router.get("/blogpost", async (req, res) => {
  try {
    const db = await connectDB();
    const post = await db
      .collection("blogposts")
      .find()
      .sort({ createdAt: -1 })
      .limit(1)
      .next();
    if (!post) {
      return res.status(404).json({ error: "No blog post found" });
    }
    const filePath = path.join(blogDir, path.basename(post.url));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Blog post file not found" });
    }
    res.set("Content-Type", "text/html");
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET all blog posts (array, unauthenticated, with HTML content)
router.get("/blogposts", async (req, res) => {
  try {
    const db = await connectDB();
    const posts = await db
      .collection("blogposts")
      .find()
      .sort({ createdAt: -1 })
      .toArray();
    const result = posts.map((post) => {
      let html = "";
      const filePath = path.join(blogDir, path.basename(post.url));
      if (fs.existsSync(filePath)) {
        html = fs.readFileSync(filePath, "utf8");
      }
      return {
        id: post._id.toString(),
        url: post.url,
        createdAt: post.createdAt,
        html,
      };
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET a blog post by id (unauthenticated, fetch from file)
router.get("/blogposts/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(id) });
    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }
    const filePath = path.join(blogDir, path.basename(post.url));
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Blog post file not found" });
    }
    res.set("Content-Type", "text/html");
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Route to increment views by id
router.get("/articles/:id", async (req, res) => {
  const { ObjectId } = require("mongodb");
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: "Invalid article id" });
  }
  try {
    const id = req.params.id;
    const db = await connectDB();
    const result = await db.collection("blogposts").findOneAndUpdate(
      { _id: new ObjectId(id) }, // filter by ObjectId
      { $inc: { views: 1 } }, // increment views by 1
      { returnDocument: "after" } // return updated document
    );
    console.log(result);

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong" });
  }
});
// DELETE a blog post by id (unauthenticated, remove file and db record)
router.delete("/blogposts/:id", async (req, res) => {
  try {
    const db = await connectDB();
    const { id } = req.params;
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid blog post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(id) });
    if (!post) {
      return res.status(404).json({ error: "Blog post not found" });
    }
    const filePath = path.join(blogDir, path.basename(post.url));
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await db.collection("blogposts").deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Blog Categories ────────────────────────────────────────────────────────
const DEFAULT_CATEGORIES = [
  { name: "Hardware Repair", color: "#ef4444" },
  { name: "Software Fixes",  color: "#6366f1" },
  { name: "Tech Tips",       color: "#10b981" },
  { name: "Mocos News",      color: "#f59e0b" },
];

// GET all blog categories
router.get("/blog-categories", async (req, res) => {
  try {
    const db = await connectDB();
    let cats = await db.collection("blog_categories").find().sort({ createdAt: 1 }).toArray();
    // Seed defaults if collection is empty
    if (cats.length === 0) {
      await db.collection("blog_categories").insertMany(
        DEFAULT_CATEGORIES.map((c) => ({ ...c, createdAt: new Date() }))
      );
      cats = await db.collection("blog_categories").find().sort({ createdAt: 1 }).toArray();
    }
    res.json(cats.map((c) => ({ id: c._id.toString(), name: c.name, color: c.color || "#6b7280" })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create a new blog category (protected)
router.post("/blog-categories", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { name, color } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }
    const exists = await db.collection("blog_categories").findOne({ name: name.trim() });
    if (exists) return res.status(409).json({ error: "Category already exists" });
    const doc = { name: name.trim(), color: color || "#6b7280", createdAt: new Date() };
    const result = await db.collection("blog_categories").insertOne(doc);
    res.status(201).json({ id: result.insertedId.toString(), name: doc.name, color: doc.color });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE a blog category (protected)
router.delete("/blog-categories/:id", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid category id" });
    const result = await db.collection("blog_categories").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) return res.status(404).json({ error: "Category not found" });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

router.post("/comments", async (req, res) => {
  const db = await connectDB();
  const { fullName, comment, postId } = req.body;
  if (!fullName || !comment || !postId) {
    return res.status(400).json({ error: "All fields are required" });
  }
  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const post = await db
      .collection("blogposts")
      .findOne({ _id: new ObjectId(postId) });
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    const doc = {
      fullName,
      comment,
      postId: new ObjectId(postId),
      createdAt: new Date(),
    };
    const result = await db.collection("comments").insertOne(doc);
    res
      .status(201)
      .json({ id: result.insertedId.toString(), fullName, comment, postId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/comments/:postId", async (req, res) => {
  const db = await connectDB();
  const { postId } = req.params;
  try {
    const { ObjectId } = require("mongodb");
    if (!ObjectId.isValid(postId)) {
      return res.status(400).json({ error: "Invalid post id" });
    }
    const comments = await db
      .collection("comments")
      .find({ postId: new ObjectId(postId) })
      .toArray();
    res.json(
      comments.map(({ _id, fullName, comment, createdAt }) => ({
        id: _id.toString(),
        fullName,
        comment,
        createdAt: createdAt.toISOString(),
      }))
    );
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post("/service-cards", async (req, res) => {
  try {
    const db = await connectDB();
    const card = req.body;
    if (!card || typeof card !== "object") {
      return res.status(400).json({ error: "Service card data required" });
    }
    const result = await db.collection("service_cards").insertOne(card);
    res.status(201).json({ id: result.insertedId.toString(), ...card });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get("/service-cards", async (req, res) => {
  try {
    const db = await connectDB();
    const cards = await db.collection("service_cards").find().toArray();
    res.json(cards.map((card) => ({ id: card._id.toString(), ...card })));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete("/service-cards/:id", async (req, res) => {
  try {
    const { ObjectId } = require("mongodb");
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid service card ID" });
    }
    const db = await connectDB();
    const result = await db.collection("service_cards").deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Service card not found" });
    }
    res.json({ message: "Service card deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change password (authenticated)
router.post("/change-password", authenticateToken, async (req, res) => {
  try {
    const db = await connectDB();
    const { oldPassword, newPassword } = req.body;
    if (!oldPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: "Old and new passwords are required" });
    }
    const user = await db
      .collection("users")
      .findOne({ username: req.user.username });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    const valid = await bcrypt.compare(oldPassword, user.password);
    if (!valid) {
      return res.status(401).json({ error: "Old password is incorrect" });
    }
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db
      .collection("users")
      .updateOne(
        { username: req.user.username },
        { $set: { password: hashedPassword } }
      );
    res.json({ message: "Password changed successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
