const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const mongoose = require("mongoose");
const multer = require("multer");
const { execFile } = require("child_process");
const fs = require("fs");
const csv = require("csv-parser");

const app = express();

// ---------------------------------------------------------------------------
// Config (override with environment variables)
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017/DataBase";
const SESSION_SECRET = process.env.SESSION_SECRET || "attendance-system-secret";
const PYTHON_CMD = process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3");
const REBUILD_CACHE = process.env.REBUILD_CACHE === "1";

if (!process.env.SESSION_SECRET) {
  console.warn("[warn] SESSION_SECRET not set - using an insecure default. Set it before deploying.");
}

const SUBJECTS = [
  "Digital Signal Processing",
  "Linear Integrated Circuits",
  "Principles of Control System",
  "Digital Communication"
];

const ROOT_DIR = path.join(__dirname, "..");
const uploadsDir = path.join(__dirname, "public", "uploads");
const attendanceImagesDir = path.join(ROOT_DIR, "attendance_images");
const attendanceOutputDir = path.join(ROOT_DIR, "attendance_output");
const rosterDir = path.join(ROOT_DIR, "roster");
const embeddingsCachePath = path.join(ROOT_DIR, "roster_embeddings.json");
const pythonScript = path.join(ROOT_DIR, "attendance_system.py");

const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".bmp"];
const IMAGE_EXT_RE = /\.(jpg|jpeg|png|webp|bmp)$/i;

// via.placeholder.com is no longer reliable, so use an inline SVG instead
const DEFAULT_AVATAR = "data:image/svg+xml;utf8," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150">' +
  '<rect width="150" height="150" fill="#d9dde3"/>' +
  '<circle cx="75" cy="58" r="26" fill="#9aa3af"/>' +
  '<path d="M25 135c4-28 26-42 50-42s46 14 50 42z" fill="#9aa3af"/></svg>'
);

function resolvePhoto(img) {
  if (!img || img.includes("via.placeholder.com")) return DEFAULT_AVATAR;
  return img;
}

// ---------------------------------------------------------------------------
// MongoDB
// ---------------------------------------------------------------------------
mongoose.connect(MONGO_URI)
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

const studentSchema = new mongoose.Schema({
  name: String,
  username: String,
  password: String,
  rollno: Number,
  branch: { type: String, default: "EE(VLSI)" },
  attendance: [{
    subject: String,
    percent: Number,
    totalClasses: { type: Number, default: 0 },
    attendedClasses: { type: Number, default: 0 }
  }],
  attendanceHistory: [{
    subject: String,
    date: Date,
    present: Boolean
  }],
  profileImage: { type: String, default: "" }
});

const teacherSchema = new mongoose.Schema({
  name: String,
  username: String,
  password: String,
  subject: String,
  department: { type: String, default: "Computer Science Department" },
  profileImage: { type: String, default: "" }
});

const Student = mongoose.model("Student", studentSchema, "Students");
const Teacher = mongoose.model("Teacher", teacherSchema, "Teachers");

// Mongo Compass exports numbers as {"$numberInt": "5"} - unwrap them
function unwrapNumber(v) {
  if (v && typeof v === "object") {
    for (const k of ["$numberInt", "$numberLong", "$numberDouble"]) {
      if (k in v) return Number(v[k]);
    }
  }
  return v;
}

function findSeedFile(fileName) {
  const candidates = [
    path.join(ROOT_DIR, "Database", fileName),
    path.join(ROOT_DIR, fileName),
    path.join(__dirname, fileName)
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

async function seedDatabaseIfEmpty() {
  try {
    const studentsCount = await Student.countDocuments();
    const teachersCount = await Teacher.countDocuments();

    if (teachersCount === 0) {
      const file = findSeedFile("DataBase.Teachers.json");
      if (file) {
        const items = JSON.parse(fs.readFileSync(file, "utf-8"));
        const docs = items.map(t => ({
          name: t.name, username: t.username, password: t.password, subject: t.subject
        }));
        if (docs.length > 0) {
          await Teacher.insertMany(docs);
          console.log(`Seeded ${docs.length} teachers from ${file}`);
        }
      } else {
        console.warn("[warn] Teachers seed file not found");
      }
    }

    if (studentsCount === 0) {
      const file = findSeedFile("DataBase.Students.json");
      if (file) {
        const items = JSON.parse(fs.readFileSync(file, "utf-8"));
        const docs = items.map(s => ({
          name: s.name, username: s.username, password: s.password, rollno: unwrapNumber(s.rollno)
        }));
        if (docs.length > 0) {
          await Student.insertMany(docs);
          console.log(`Seeded ${docs.length} students from ${file}`);
        }
      } else {
        console.warn("[warn] Students seed file not found");
      }
    }
  } catch (err) {
    console.error("Database seeding error:", err);
  }
}

mongoose.connection.once("open", seedDatabaseIfEmpty);

// ---------------------------------------------------------------------------
// Uploads (multer)
// ---------------------------------------------------------------------------
[uploadsDir, attendanceImagesDir, attendanceOutputDir, rosterDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// The extension comes from the client, so only allow known-safe ones
function safeExt(originalName) {
  const ext = path.extname(originalName || "").toLowerCase();
  return IMAGE_EXTS.includes(ext) ? ext : "";
}

function imageFileFilter(req, file, cb) {
  if (file.mimetype && file.mimetype.startsWith("image/") && safeExt(file.originalname)) {
    return cb(null, true);
  }
  cb(new Error("Only image files (jpg, jpeg, png, webp, bmp) are allowed"));
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, Date.now() + safeExt(file.originalname))
});

const attendanceStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, attendanceImagesDir),
  filename: (req, file, cb) => {
    const teacherId = req.session?.user?.id || "unknown";
    cb(null, `${teacherId}_${Date.now()}_classroom${safeExt(file.originalname)}`);
  }
});

const limits = { fileSize: 15 * 1024 * 1024 };
const upload = multer({ storage, fileFilter: imageFileFilter, limits });
const uploadAttendance = multer({ storage: attendanceStorage, fileFilter: imageFileFilter, limits });

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/roster", express.static(rosterDir));
app.use("/attendance_images", express.static(attendanceImagesDir));
app.use("/attendance_output", express.static(attendanceOutputDir));

app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, httpOnly: true, sameSite: "lax" }
}));

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function norm(s) {
  return String(s || "").toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
}

// Roster photos are named by the person (e.g. "Aditya.jpg" or "Aditya Kumar.jpg")
function findRosterPhotoForName(fullName) {
  try {
    const files = fs.readdirSync(rosterDir).filter(f => IMAGE_EXT_RE.test(f));
    const full = norm(fullName);
    if (!full) return null;
    const tokens = full.split(" ");
    const stem = f => norm(path.parse(f).name);
    const best = files.find(f => stem(f) === full)
      || files.find(f => stem(f) === tokens[0])
      || files.find(f => tokens.includes(stem(f)));
    return best ? "/roster/" + encodeURIComponent(best) : null;
  } catch (_) {
    return null;
  }
}

/**
 * Work out which students were recognised. Roster names come from photo
 * filenames, so they may be full names or just first names. Matching is by
 * whole words only (no substring checks - "Aditya" must not match
 * "Adityananda"), and a name that matches more than one student is skipped
 * instead of guessed.
 */
function resolvePresentStudentIds(students, presentNames) {
  const info = students.map(s => {
    const full = norm(s.name);
    return { id: s._id.toString(), full, tokens: full.split(" ").filter(Boolean) };
  });
  const present = new Set();

  for (const raw of presentNames) {
    const n = norm(raw);
    if (!n) continue;
    let c = info.filter(i => i.full === n);
    if (c.length === 0) c = info.filter(i => i.tokens[0] === n);
    if (c.length === 0) c = info.filter(i => i.tokens.includes(n));

    if (c.length === 1) present.add(c[0].id);
    else if (c.length > 1) console.warn(`[warn] Roster name "${raw}" matches ${c.length} students - skipped. Use full names for roster photos.`);
    else console.warn(`[warn] Roster name "${raw}" does not match any student`);
  }
  return present;
}

// "2026-10-01" -> local start/end of that day; anything else -> null
function parseDateParam(value, endOfDay) {
  if (!value) return null;
  const str = String(value);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str)
    ? new Date(str + (endOfDay ? "T23:59:59.999" : "T00:00:00"))
    : new Date(str);
  return isNaN(d.getTime()) ? undefined : d;
}

// ---------------------------------------------------------------------------
// Python attendance script
// ---------------------------------------------------------------------------
function processAttendance(classroomImagePath, callback) {
  const args = [
    pythonScript,
    "--image", classroomImagePath,
    "--roster_dir", rosterDir,
    "--out_dir", attendanceOutputDir,
    "--cache", embeddingsCachePath
  ];
  // The fixed attendance_system.py rebuilds the cache itself when roster
  // photos change. Set REBUILD_CACHE=1 to force it every time.
  if (REBUILD_CACHE) args.push("--rebuild-cache");

  console.log("Running attendance script:", PYTHON_CMD, args.join(" "));

  // execFile (no shell) so a crafted filename can't inject commands
  execFile(PYTHON_CMD, args, { cwd: ROOT_DIR, maxBuffer: 20 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    (error, stdout, stderr) => {
      if (stderr) console.error("Python script stderr:", stderr);
      if (error) {
        console.error("Python script error:", error);
        return callback(error, null);
      }
      console.log("Python script output:", stdout);

      // Use the exact files this run produced (safe with concurrent uploads)
      let csvPath = null;
      let previewPath = null;
      const csvMatch = stdout.match(/(?:Face log CSV|Attendance CSV written):\s*(.+)/);
      const prevMatch = stdout.match(/Preview image:\s*(.+)/);
      if (csvMatch && fs.existsSync(csvMatch[1].trim())) csvPath = csvMatch[1].trim();
      if (prevMatch && fs.existsSync(prevMatch[1].trim())) previewPath = prevMatch[1].trim();

      if (!csvPath) {
        const csvFiles = fs.readdirSync(attendanceOutputDir)
          .filter(f => f.startsWith("attendance_") && f.endsWith(".csv"))
          .map(f => ({ name: f, time: fs.statSync(path.join(attendanceOutputDir, f)).mtime.getTime() }))
          .sort((a, b) => b.time - a.time);
        if (csvFiles.length === 0) return callback(new Error("No CSV file generated"), null);
        csvPath = path.join(attendanceOutputDir, csvFiles[0].name);
      }

      const names = [];
      fs.createReadStream(csvPath)
        .pipe(csv())
        .on("data", (row) => {
          if (row.name && row.name !== "Unknown") names.push(row.name);
        })
        .on("end", () => {
          console.log("Attendance results:", names);
          callback(null, { names: Array.from(new Set(names)), previewPath });
        })
        .on("error", (err) => callback(err, null));
    });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.get("/", (req, res) => {
  res.render("index", { errorMessage: "" });
});

app.post("/login", async (req, res) => {
  const { username, password, role } = req.body;

  // Reject non-string values (prevents NoSQL operator injection like username[$ne]=x)
  if (typeof username !== "string" || typeof password !== "string") {
    return res.render("index", { errorMessage: "Invalid username, password, or role!" });
  }

  try {
    const query = { username: username.trim(), password: password.trim() };
    let user = null;

    if (role === "student") {
      user = await Student.findOne(query);
    } else if (role === "teacher") {
      user = await Teacher.findOne(query);
    }

    if (user) {
      req.session.user = { id: user._id, name: user.name, username: user.username, role };
      return res.redirect(role === "student" ? "/student" : "/teacher");
    }

    console.log("Failed login for username:", query.username, "role:", role);
    res.render("index", { errorMessage: "Invalid username, password, or role!" });
  } catch (error) {
    console.error("Login error:", error);
    res.render("index", { errorMessage: "Login failed. Please try again." });
  }
});

app.get("/student", async (req, res) => {
  if (!req.session.user || req.session.user.role !== "student") {
    return res.redirect("/");
  }

  try {
    const student = await Student.findById(req.session.user.id);
    if (!student) return res.redirect("/");

    if (!student.profileImage || student.profileImage.includes("via.placeholder.com")) {
      const rosterPhoto = findRosterPhotoForName(student.name);
      if (rosterPhoto) {
        student.profileImage = rosterPhoto;
        await student.save();
      }
    }

    const formattedAttendance = (student.attendance || []).map(att => ({
      subject: att.subject,
      percent: att.percent || 0,
      totalClasses: att.totalClasses || 0,
      attendedClasses: att.attendedClasses || 0
    }));

    res.render("student", {
      name: student.name,
      branch: student.branch,
      photo: resolvePhoto(student.profileImage),
      attendance: formattedAttendance
    });
  } catch (error) {
    console.error("Student page error:", error);
    res.redirect("/");
  }
});

app.get("/teacher", async (req, res) => {
  if (!req.session.user || req.session.user.role !== "teacher") {
    return res.redirect("/");
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher) return res.redirect("/");

    const students = await Student.find({});
    const formattedStudents = students.map(student => {
      const attendance = student.attendance || [];
      const result = { name: student.name, branch: student.branch };
      SUBJECTS.forEach(subject => {
        const att = attendance.find(a => a.subject === subject);
        result[subject] = att ? att.percent || 0 : 0;
        result[`${subject}_total`] = att ? att.totalClasses || 0 : 0;
        result[`${subject}_attended`] = att ? att.attendedClasses || 0 : 0;
      });
      return result;
    });

    const teacherId = teacher._id.toString();
    let recentUploads = [];
    let recentPreviews = [];

    try {
      recentUploads = fs.readdirSync(attendanceImagesDir)
        .filter(f => f.startsWith(teacherId + "_") && IMAGE_EXT_RE.test(f))
        .map(f => {
          const st = fs.statSync(path.join(attendanceImagesDir, f));
          return { name: f, time: st.mtime.getTime(), date: st.mtime };
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, 12)
        .map(x => ({ url: "/attendance_images/" + x.name, date: x.date.toISOString().slice(0, 10) }));
    } catch (_) {}

    try {
      const uploadTimestamps = recentUploads
        .map(u => { const m = u.url.match(/(\d{13})_classroom/); return m ? parseInt(m[1], 10) : null; })
        .filter(ts => ts !== null);

      recentPreviews = fs.readdirSync(attendanceOutputDir)
        .filter(f => {
          if (!f.startsWith("preview_") || !IMAGE_EXT_RE.test(f)) return false;

          // New naming: preview_<teacherId>_<timestamp>.jpg (exact ownership)
          if (f.startsWith(`preview_${teacherId}_`)) return true;

          // Legacy naming: preview_YYYYMMDD_HHMMSS.jpg - match by time (10 min window,
          // the old 2 min window missed uploads when processing was slow)
          const t = f.match(/preview_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
          if (!t) return false;
          const previewTs = new Date(`${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}`).getTime();
          return uploadTimestamps.some(ts => Math.abs(previewTs - ts) < 10 * 60 * 1000);
        })
        .map(f => {
          const st = fs.statSync(path.join(attendanceOutputDir, f));
          return { name: f, time: st.mtime.getTime(), date: st.mtime };
        })
        .sort((a, b) => b.time - a.time)
        .slice(0, 15)
        .map(x => ({ url: "/attendance_output/" + x.name, date: x.date.toISOString().slice(0, 10) }));
    } catch (_) {}

    res.render("teacher", {
      name: teacher.name,
      subject: teacher.subject,
      photo: resolvePhoto(teacher.profileImage),
      students: formattedStudents,
      recentUploads,
      recentPreviews
    });
  } catch (error) {
    console.error("Teacher page error:", error);
    res.redirect("/");
  }
});

app.post("/upload-teacher-photo", upload.single("photo"), async (req, res) => {
  if (!req.session.user || req.session.user.role !== "teacher") {
    return res.status(401).send("Unauthorized");
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (teacher && req.file) {
      teacher.profileImage = "/uploads/" + req.file.filename;
      await teacher.save();
    }
    res.redirect("/teacher");
  } catch (error) {
    console.error("Upload error:", error);
    res.redirect("/teacher");
  }
});

// Export attendance CSV (date-wise P/AB sheet)
app.get("/export-attendance", async (req, res) => {
  if (!req.session.user || req.session.user.role !== "teacher") {
    return res.status(401).send("Unauthorized");
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher) return res.redirect("/");

    const subject = String(req.query.subject || teacher.subject || "").trim();
    if (!subject) return res.status(400).send("Subject is required");

    const from = parseDateParam(req.query.from, false);
    const to = parseDateParam(req.query.to, true);
    if (from === undefined || to === undefined) {
      return res.status(400).send("Invalid 'from' or 'to' date");
    }

    const students = await Student.find({}).sort({ rollno: 1 }).lean();

    // Each unique timestamp is one lecture session
    const lectureSessions = new Map();
    students.forEach(st => {
      (st.attendanceHistory || []).forEach(h => {
        if (h.subject !== subject) return;
        const d = new Date(h.date);
        if ((from && d < from) || (to && d > to)) return;
        const key = d.toISOString();
        if (!lectureSessions.has(key)) {
          lectureSessions.set(key, {
            dateStr: d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" }),
            fullDate: d
          });
        }
      });
    });

    const sortedSessions = Array.from(lectureSessions.values())
      .sort((a, b) => a.fullDate.getTime() - b.fullDate.getTime());

    const sessionsPerDate = new Map();
    sortedSessions.forEach(s => sessionsPerDate.set(s.dateStr, (sessionsPerDate.get(s.dateStr) || 0) + 1));

    // Column headers: "DD/MM/YYYY" or "DD/MM/YYYY (Session N)" when several lectures share a day
    const columnHeaders = ["Roll No.", "Name"];
    const seenPerDate = new Map();
    sortedSessions.forEach(s => {
      if (sessionsPerDate.get(s.dateStr) === 1) {
        columnHeaders.push(s.dateStr);
      } else {
        const n = (seenPerDate.get(s.dateStr) || 0) + 1;
        seenPerDate.set(s.dateStr, n);
        columnHeaders.push(`${s.dateStr} (Session ${n})`);
      }
    });

    const sameSession = (h, session) =>
      h.subject === subject && Math.abs(new Date(h.date).getTime() - session.fullDate.getTime()) < 60000;

    const rows = [columnHeaders];
    students.forEach(st => {
      const line = [st.rollno || "", st.name];
      sortedSessions.forEach(session => {
        const hist = (st.attendanceHistory || []).find(h => sameSession(h, session));
        line.push(hist ? (hist.present ? "P" : "AB") : "");
      });
      rows.push(line);
    });

    const summaryRow = ["", "TOTAL ATTENDED"];
    sortedSessions.forEach(session => {
      const count = students.filter(st =>
        (st.attendanceHistory || []).some(h => sameSession(h, session) && h.present)
      ).length;
      summaryRow.push(count);
    });
    rows.push([]);
    rows.push(summaryRow);

    const csvData = rows.map(r => r.map(v => {
      if (v === null || v === undefined) return "";
      const str = String(v);
      return /[",\n]/.test(str) ? '"' + str.replace(/"/g, '""') + '"' : str;
    }).join(",")).join("\n");

    const safeSubject = subject.replace(/[^\w-]+/g, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",
      `attachment; filename="attendance_${safeSubject}_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("\uFEFF" + csvData);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).send("Failed to export attendance: " + err.message);
  }
});

// Upload classroom image and mark attendance
app.post("/mark-attendance", uploadAttendance.single("classroomImage"), async (req, res) => {
  if (!req.session.user || req.session.user.role !== "teacher") {
    return res.status(401).json({ success: false, message: "Unauthorized" });
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher || !req.file) {
      return res.status(400).json({ success: false, message: "Invalid request: teacher or image missing" });
    }

    const subject = String(req.body.subject || teacher.subject || "").trim();
    const allowedSubjects = new Set([...SUBJECTS, teacher.subject].filter(Boolean));
    if (!allowedSubjects.has(subject)) {
      return res.status(400).json({ success: false, message: "Unknown subject" });
    }

    console.log(`Processing attendance for subject: ${subject}`);

    processAttendance(req.file.path, async (error, result) => {
      if (error) {
        console.error("Attendance processing error:", error);
        const msg = error.code === "ENOENT"
          ? `Python not found ("${PYTHON_CMD}"). Install Python or set the PYTHON_CMD environment variable.`
          : "Failed to process attendance. Make sure Python and required libraries (insightface, onnxruntime, opencv-python, numpy) are installed.";
        return res.status(500).json({ success: false, message: msg });
      }

      const presentNames = result.names;

      // Give the preview a name that records which teacher it belongs to
      if (result.previewPath) {
        try {
          const renamed = path.join(attendanceOutputDir, `preview_${teacher._id}_${Date.now()}.jpg`);
          fs.renameSync(result.previewPath, renamed);
        } catch (e) {
          console.warn("[warn] Could not rename preview:", e.message);
        }
      }

      try {
        const allStudents = await Student.find({});
        const presentIds = resolvePresentStudentIds(allStudents, presentNames);

        // A photo where nobody is recognised is almost certainly a bad photo, not a
        // class where everyone is absent - don't wipe everyone's percentage.
        if (presentIds.size === 0) {
          return res.status(422).json({
            success: false,
            message: "No registered students were recognised in the image. Attendance was not recorded. Try a clearer photo."
          });
        }

        const sessionDate = new Date();

        for (const student of allStudents) {
          let entry = student.attendance.find(a => a.subject === subject);
          if (!entry) {
            student.attendance.push({ subject, percent: 0, totalClasses: 0, attendedClasses: 0 });
            // Re-read from the array so we modify the saved subdocument, not a detached copy
            entry = student.attendance[student.attendance.length - 1];
          }

          const isPresent = presentIds.has(student._id.toString());

          entry.totalClasses = (entry.totalClasses || 0) + 1;
          if (isPresent) entry.attendedClasses = (entry.attendedClasses || 0) + 1;
          entry.percent = Math.round((entry.attendedClasses / entry.totalClasses) * 100);

          student.attendanceHistory.push({ subject, date: sessionDate, present: isPresent });
          await student.save();
        }

        res.json({
          success: true,
          message: `Attendance marked successfully. Present: ${presentIds.size} students`,
          presentStudents: presentNames
        });
      } catch (dbError) {
        console.error("Database update error:", dbError);
        res.status(500).json({ success: false, message: "Failed to update attendance in database" });
      }
    });
  } catch (error) {
    console.error("Attendance marking error:", error);
    res.status(500).json({ success: false, message: "An error occurred while marking attendance" });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.redirect("/");
  });
});

// Upload errors (wrong file type, file too large, ...)
app.use((err, req, res, next) => {
  if (!err) return next();
  const isUploadError = err instanceof multer.MulterError || /Only image files/.test(err.message || "");
  const status = isUploadError ? 400 : 500;
  if (req.path === "/mark-attendance") {
    return res.status(status).json({ success: false, message: err.message });
  }
  console.error("Unhandled error:", err);
  res.status(status).send(err.message);
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});