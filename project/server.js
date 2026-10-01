const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const mongoose = require("mongoose");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const csv = require("csv-parser");

const app = express();
const PORT = 3000;

// MongoDB connection
mongoose.connect("mongodb://localhost:27017/DataBase")
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Student Schema
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
  profileImage: { type: String, default: "https://via.placeholder.com/150" }
});

// Teacher Schema
const teacherSchema = new mongoose.Schema({
  name: String,
  username: String,
  password: String,
  subject: String,
  department: { type: String, default: "Computer Science Department" },
  profileImage: { type: String, default: "https://via.placeholder.com/150" }
});

const Student = mongoose.model("Student", studentSchema, "Students");
const Teacher = mongoose.model("Teacher", teacherSchema, "Teachers");

// Seed database from JSON files if empty
async function seedDatabaseIfEmpty() {
  try {
    const studentsCount = await Student.countDocuments();
    const teachersCount = await Teacher.countDocuments();

    const dbDir = path.join(__dirname, "..", "Database");
    const studentsJsonPath = path.join(dbDir, "DataBase.Students.json");
    const teachersJsonPath = path.join(dbDir, "DataBase.Teachers.json");

    if (teachersCount === 0 && fs.existsSync(teachersJsonPath)) {
      const raw = fs.readFileSync(teachersJsonPath, "utf-8");
      const items = JSON.parse(raw);
      const docs = items.map(t => ({
        name: t.name,
        username: t.username,
        password: t.password,
        subject: t.subject
      }));
      if (docs.length > 0) {
        await Teacher.insertMany(docs);
        console.log(`Seeded ${docs.length} teachers`);
      }
    }

    if (studentsCount === 0 && fs.existsSync(studentsJsonPath)) {
      const raw = fs.readFileSync(studentsJsonPath, "utf-8");
      const items = JSON.parse(raw);
      const docs = items.map(s => ({
        name: s.name,
        username: s.username,
        password: s.password,
        rollno: s.rollno
      }));
      if (docs.length > 0) {
        await Student.insertMany(docs);
        console.log(`Seeded ${docs.length} students`);
      }
    }
  } catch (err) {
    console.error("Database seeding error:", err);
  }
}

mongoose.connection.once('open', async () => {
  await seedDatabaseIfEmpty();
});

// Multer storage configuration for file uploads
const uploadsDir = path.join(__dirname, "public/uploads");
const attendanceImagesDir = path.join(__dirname, "..", "attendance_images");
const attendanceOutputDir = path.join(__dirname, "..", "attendance_output");
const rosterDirPublic = path.join(__dirname, "..", "roster");

// Ensure directories exist
[uploadsDir, attendanceImagesDir, attendanceOutputDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});

const attendanceStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, attendanceImagesDir);
  },
  filename: function (req, file, cb) {
    // Include teacher ID in filename for tracking
    const teacherId = req.session?.user?.id || 'unknown';
    cb(null, `${teacherId}_${Date.now()}_classroom${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage: storage });
const uploadAttendance = multer({ storage: attendanceStorage });

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));
// Serve helpful dirs for images
app.use('/roster', express.static(rosterDirPublic));
app.use('/attendance_images', express.static(attendanceImagesDir));
app.use('/attendance_output', express.static(attendanceOutputDir));

function findRosterPhotoForName(fullName) {
  try {
    const files = fs.readdirSync(rosterDirPublic);
    const lower = fullName.toLowerCase();
    let best = files.find(f => f.toLowerCase().startsWith(lower + '.'));
    if (!best) {
      const first = lower.split(' ')[0];
      best = files.find(f => f.toLowerCase().startsWith(first + '.'))
          || files.find(f => f.toLowerCase().includes(first));
    }
    return best ? ('/roster/' + best) : null;
  } catch (_) {
    return null;
  }
}

// Session middleware
app.use(session({
  secret: 'attendance-system-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false } 
}));

// Set EJS as view engine
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

// Routes
app.get("/", (req, res) => {
  res.render("index", { errorMessage: "" });
});

app.post("/login", async (req, res) => {
  const { username, password, role } = req.body;
  console.log("Login attempt:", { username, password, role });
  
  try {
    let user = null;
    
    if (role === "student") {
      user = await Student.findOne({ username: username.trim(), password: password.trim() });
      if (user) {
        console.log("Student found:", user);
        req.session.user = {
          id: user._id,
          name: user.name,
          username: user.username,
          role: 'student'
        };
        return res.redirect("/student");
      }
    } else if (role === "teacher") {
      user = await Teacher.findOne({ username: username.trim(), password: password.trim() });
      if (user) {
        console.log("Teacher found:", user);
        req.session.user = {
          id: user._id,
          name: user.name,
          username: user.username,
          role: 'teacher'
        };
        return res.redirect("/teacher");
      }
    }
    
    console.log("No user found for:", { username, password, role });
    res.render("index", { errorMessage: "Invalid username, password, or role!" });
    
  } catch (error) {
    console.error("Login error:", error);
    res.render("index", { errorMessage: "Login failed. Please try again." });
  }
});

app.get("/student", async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'student') {
    return res.redirect("/");
  }
  
  try {
    const student = await Student.findById(req.session.user.id);
    if (!student) {
      return res.redirect("/");
    }
    
    // Auto-assign roster photo if profileImage is placeholder
    if (!student.profileImage || student.profileImage.includes('via.placeholder.com')) {
      const rosterPhoto = findRosterPhotoForName(student.name);
      if (rosterPhoto) {
        student.profileImage = rosterPhoto;
        await student.save();
      }
    }

    // Format attendance data
    const formattedAttendance = (student.attendance || []).map(att => ({
      subject: att.subject,
      percent: att.percent || 0,
      totalClasses: att.totalClasses || 0,
      attendedClasses: att.attendedClasses || 0
    }));

    res.render("student", {
      name: student.name,
      branch: student.branch,
      photo: student.profileImage,
      attendance: formattedAttendance
    });
  } catch (error) {
    console.error("Student page error:", error);
    res.redirect("/");
  }
});

app.get("/teacher", async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') {
    return res.redirect("/");
  }
  
  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher) {
      return res.redirect("/");
    }
    
    const students = await Student.find({});
    const subjects = ["Digital Signal Processing", "Linear Integrated Circuits", "Principles of Control System", "Digital Communication"];
    const formattedStudents = students.map(student => {
      const attendance = student.attendance || [];
      const result = {
        name: student.name,
        branch: student.branch
      };
      subjects.forEach(subject => {
        const att = attendance.find(a => a.subject === subject);
        result[subject] = att ? att.percent || 0 : 0;
        result[`${subject}_total`] = att ? att.totalClasses || 0 : 0;
        result[`${subject}_attended`] = att ? att.attendedClasses || 0 : 0;
      });
      return result;
    });
    
    // List recent uploaded and preview images - only for this teacher
    const teacherId = teacher._id.toString();
    let recentUploads = [];
    let recentPreviews = [];
    try {
      recentUploads = fs.readdirSync(attendanceImagesDir)
        .filter(f => {
          // Only show images uploaded by this teacher (starts with teacher ID)
          if (!f.startsWith(teacherId + '_')) return false;
          return /\.(jpg|jpeg|png|webp)$/i.test(f);
        })
        .map(f => ({ 
          name: f, 
          time: fs.statSync(path.join(attendanceImagesDir, f)).mtime.getTime(),
          date: fs.statSync(path.join(attendanceImagesDir, f)).mtime
        }))
        .sort((a,b) => b.time - a.time)
        .slice(0, 12)
        .map(x => ({ 
          url: '/attendance_images/' + x.name,
          date: x.date.toISOString().slice(0,10)
        }));
    } catch (_) {}
    try {
      // For previews, match by timestamp - find previews created around the same time as teacher's uploads
      // Get all upload timestamps from this teacher
      const teacherUploadTimestamps = recentUploads.map(u => {
        const match = u.url.match(/(\d{13})_classroom/);
        return match ? parseInt(match[1]) : null;
      }).filter(ts => ts !== null);
      
      recentPreviews = fs.readdirSync(attendanceOutputDir)
        .filter(f => {
          if (!f.startsWith('preview_')) return false;
          if (!/\.(jpg|jpeg|png|webp)$/i.test(f)) return false;
          
          // Extract timestamp from preview filename (format: preview_YYYYMMDD_HHMMSS.jpg)
          const tsMatch = f.match(/preview_(\d{8})_(\d{6})/);
          if (tsMatch) {
            const year = tsMatch[1].substring(0,4);
            const month = tsMatch[1].substring(4,6);
            const day = tsMatch[1].substring(6,8);
            const hour = tsMatch[2].substring(0,2);
            const minute = tsMatch[2].substring(2,4);
            const second = tsMatch[2].substring(4,6);
            
            // Convert to milliseconds timestamp
            const previewTs = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}`).getTime();
            
            // Check if preview was created within 2 minutes of any teacher upload
            return teacherUploadTimestamps.some(uploadTs => {
              const timeDiff = Math.abs(previewTs - uploadTs);
              return timeDiff < 120000; // 2 minutes tolerance
            });
          }
          return false;
        })
        .map(f => ({ 
          name: f, 
          time: fs.statSync(path.join(attendanceOutputDir, f)).mtime.getTime(),
          date: fs.statSync(path.join(attendanceOutputDir, f)).mtime
        }))
        .sort((a,b) => b.time - a.time)
        .slice(0, 15)
        .map(x => ({ 
          url: '/attendance_output/' + x.name,
          date: x.date.toISOString().slice(0,10)
        }));
    } catch (_) {}

    res.render("teacher", {
      name: teacher.name,
      subject: teacher.subject,
      photo: teacher.profileImage,
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
  if (!req.session.user || req.session.user.role !== 'teacher') {
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
app.get('/export-attendance', async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') {
    return res.status(401).send('Unauthorized');
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher) return res.redirect('/');

    const subject = (req.query.subject || teacher.subject || '').trim();
    if (!subject) {
      return res.status(400).send('Subject is required');
    }

    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const students = await Student.find({}).lean().sort({ rollno: 1 });

    // Collect ALL lecture sessions (with timestamp) from attendanceHistory for this subject
    // Each unique timestamp represents a separate lecture session
    const lectureSessions = new Map(); // key: timestamp ISO string, value: {date, time, index}
    
    students.forEach(st => {
      (st.attendanceHistory || []).forEach(h => {
        if (h.subject === subject) {
          const d = new Date(h.date);
          if ((!from || d >= from) && (!to || d <= to)) {
            const timestamp = d.toISOString();
            if (!lectureSessions.has(timestamp)) {
              const dateStr = d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
              const timeStr = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
              lectureSessions.set(timestamp, {
                timestamp: timestamp,
                dateStr: dateStr,
                timeStr: timeStr,
                fullDate: d
              });
            }
          }
        }
      });
    });

    // Sort sessions by date and time
    const sortedSessions = Array.from(lectureSessions.values())
      .sort((a, b) => a.fullDate.getTime() - b.fullDate.getTime());

    // Group sessions by date to handle multiple lectures per day
    const sessionsByDate = new Map();
    sortedSessions.forEach((session, index) => {
      const dateKey = session.dateStr;
      if (!sessionsByDate.has(dateKey)) {
        sessionsByDate.set(dateKey, []);
      }
      sessionsByDate.get(dateKey).push(session);
    });

    // Build column headers - format: "DD/MM/YYYY" or "DD/MM/YYYY (Session N)" if multiple per day
    const columnHeaders = ['Roll No.', 'Name'];
    const sessionCountByDate = new Map(); // Track session number per date
    
    sortedSessions.forEach(session => {
      const dateKey = session.dateStr;
      const sessionsOnDate = sessionsByDate.get(dateKey);
      
      if (sessionsOnDate.length === 1) {
        // Single lecture on this date
        columnHeaders.push(session.dateStr);
      } else {
        // Multiple lectures on same date - add session number
        if (!sessionCountByDate.has(dateKey)) {
          sessionCountByDate.set(dateKey, 0);
        }
        const currentCount = sessionCountByDate.get(dateKey) + 1;
        sessionCountByDate.set(dateKey, currentCount);
        columnHeaders.push(`${session.dateStr} (Session ${currentCount})`);
      }
    });

    // Build CSV rows
    const rows = [columnHeaders];
    students.forEach(st => {
      const line = [st.rollno || '', st.name];
      
      sortedSessions.forEach(session => {
        // Find exact matching history entry for this timestamp
        const hist = (st.attendanceHistory || []).find(h => {
          if (h.subject !== subject) return false;
          const hDate = new Date(h.date);
          // Match within 1 minute tolerance (in case of slight timestamp differences)
          const timeDiff = Math.abs(hDate.getTime() - session.fullDate.getTime());
          return timeDiff < 60000;
        });
        
        line.push(hist ? (hist.present ? 'P' : 'AB') : '');
      });
      
      rows.push(line);
    });

    // Add summary row at the end
    const summaryRow = ['', 'TOTAL ATTENDED'];
    sortedSessions.forEach(session => {
      let presentCount = 0;
      students.forEach(st => {
        const hist = (st.attendanceHistory || []).find(h => {
          if (h.subject !== subject) return false;
          const hDate = new Date(h.date);
          const timeDiff = Math.abs(hDate.getTime() - session.fullDate.getTime());
          return timeDiff < 60000 && h.present;
        });
        if (hist) presentCount++;
      });
      summaryRow.push(presentCount);
    });
    rows.push([]); // Empty row
    rows.push(summaryRow);

    // Convert to CSV format
    const csvData = rows.map(r => {
      return r.map(v => {
        if (v === null || v === undefined) return '';
        const str = String(v);
        // Escape quotes and wrap in quotes if contains comma, quote, or newline
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      }).join(',');
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="attendance_${subject.replace(/\s+/g,'_')}_${new Date().toISOString().slice(0,10)}.csv"`);
    res.send('\uFEFF' + csvData); // Add BOM for Excel compatibility
  } catch (err) {
    console.error('Export error:', err);
    res.status(500).send('Failed to export attendance: ' + err.message);
  }
});

// Function to run Python attendance script
function processAttendance(classroomImagePath, subject, callback) {
  const rosterDir = path.join(__dirname, "..", "roster");
  const outputDir = path.join(__dirname, "..", "attendance_output");
  const pythonScript = path.join(__dirname, "..", "attendance_system.py");
  
  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Use 'python' on Linux/Mac, 'py' or 'python' on Windows
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  // Add --rebuild-cache flag to include newly added roster photos
  // Using default threshold 0.38 (reverted from 0.30 for better accuracy)
  const command = `${pythonCmd} "${pythonScript}" --image "${classroomImagePath}" --roster_dir "${rosterDir}" --out_dir "${outputDir}" --rebuild-cache`;
  
  console.log("Running attendance script:", command);
  
  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error("Python script error:", error);
      return callback(error, null);
    }
    
    console.log("Python script output:", stdout);
    if (stderr) console.error("Python script stderr:", stderr);
    
    // Find the most recent CSV file
    const csvFiles = fs.readdirSync(outputDir)
      .filter(file => file.startsWith("attendance_") && file.endsWith(".csv"))
      .map(file => ({
        name: file,
        time: fs.statSync(path.join(outputDir, file)).mtime.getTime()
      }))
      .sort((a, b) => b.time - a.time);
    
    if (csvFiles.length === 0) {
      return callback(new Error("No CSV file generated"), null);
    }
    
    const latestCsv = path.join(outputDir, csvFiles[0].name);
    const results = [];
    
    // Parse CSV file
    fs.createReadStream(latestCsv)
      .pipe(csv())
      .on('data', (row) => {
        if (row.name && row.name !== "Unknown") {
          results.push(row.name);
        }
      })
      .on('end', () => {
        console.log("Attendance results:", results);
        callback(null, results);
      })
      .on('error', (err) => {
        callback(err, null);
      });
  });
}

// Route for uploading classroom image for attendance
app.post("/mark-attendance", uploadAttendance.single("classroomImage"), async (req, res) => {
  if (!req.session.user || req.session.user.role !== 'teacher') {
    return res.status(401).send("Unauthorized");
  }

  try {
    const teacher = await Teacher.findById(req.session.user.id);
    if (!teacher || !req.file) {
      return res.status(400).send("Invalid request");
    }

    const subject = req.body.subject || teacher.subject;
    const classroomImagePath = req.file.path;

    console.log(`Processing attendance for subject: ${subject}`);
    
    // Process attendance using Python script
    processAttendance(classroomImagePath, subject, async (error, presentStudents) => {
      if (error) {
        console.error("Attendance processing error:", error);
        return res.status(500).json({ 
          success: false, 
          message: "Failed to process attendance. Make sure Python and required libraries are installed." 
        });
      }

      try {
        // Get all students
        const allStudents = await Student.find({});
        const subjectName = subject;
        const sessionDate = new Date();

        // Update attendance for each student
        for (const student of allStudents) {
          // Find or create attendance entry for this subject
          let attendanceEntry = student.attendance.find(a => a.subject === subjectName);
          
          if (!attendanceEntry) {
            attendanceEntry = {
              subject: subjectName,
              percent: 0,
              totalClasses: 0,
              attendedClasses: 0
            };
            student.attendance.push(attendanceEntry);
          }

          // Increment total classes for all students
          attendanceEntry.totalClasses = (attendanceEntry.totalClasses || 0) + 1;

          // Check if student was present (flexible matching: first name or full name)
          const studentName = student.name.trim();
          const studentFirstName = studentName.split(' ')[0].trim();
          const isPresent = presentStudents.some(presentName => {
            const presentTrim = presentName.trim();
            // Try exact match first, then first name match
            return presentTrim === studentName || 
                   presentTrim === studentFirstName ||
                   studentName.includes(presentTrim) ||
                   presentTrim.includes(studentFirstName);
          });

          if (isPresent) {
            attendanceEntry.attendedClasses = (attendanceEntry.attendedClasses || 0) + 1;
          }

          // Calculate percentage
          if (attendanceEntry.totalClasses > 0) {
            attendanceEntry.percent = Math.round(
              (attendanceEntry.attendedClasses / attendanceEntry.totalClasses) * 100
            );
          }

          // Record history for CSV export
          if (!Array.isArray(student.attendanceHistory)) student.attendanceHistory = [];
          student.attendanceHistory.push({ subject: subjectName, date: sessionDate, present: !!isPresent });

          // Update the attendance array
          const index = student.attendance.findIndex(a => a.subject === subjectName);
          student.attendance[index] = attendanceEntry;

          await student.save();
        }

        res.json({ 
          success: true, 
          message: `Attendance marked successfully. Present: ${presentStudents.length} students`,
          presentStudents: presentStudents
        });
      } catch (dbError) {
        console.error("Database update error:", dbError);
        res.status(500).json({ 
          success: false, 
          message: "Failed to update attendance in database" 
        });
      }
    });
  } catch (error) {
    console.error("Attendance marking error:", error);
    res.status(500).json({ 
      success: false, 
      message: "An error occurred while marking attendance" 
    });
  }
});

app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Session destroy error:", err);
    }
    res.redirect("/");
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});