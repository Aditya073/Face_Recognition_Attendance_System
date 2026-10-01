# Attendance System Integration Guide

This guide explains how to use the integrated attendance system that combines the Python face recognition system with the web portal.

## Prerequisites

### 1. Python Environment
- Python 3.7 or higher
- Required Python packages:
  ```bash
  pip install opencv-python numpy insightface
  ```

### 2. Node.js Environment
- Node.js 14 or higher
- MongoDB running on `localhost:27017`

### 3. Install Node.js Dependencies
```bash
cd project
npm install
```

## Setup Instructions

### 1. Directory Structure
Ensure your directory structure looks like this:
```
Your Project/
├── attendance_system.py       # Python attendance script
├── roster/                     # Student photos (one per student)
│   ├── Shashwat.jpg
│   ├── Revan.jpg
│   └── ...
├── roster_embeddings.json      # Auto-generated cache file
├── attendance_output/          # Auto-generated CSV and preview images
├── attendance_images/          # Auto-generated (classroom photos)
└── project/
    ├── server.js
    ├── public/
    │   └── uploads/            # User profile photos
    └── views/
        ├── teacher.ejs
        └── student.ejs
```

### 2. Student Roster Setup
- Place student photos in the `roster/` directory
- **Important:** Photo filenames must match student names in the database exactly
- Example: If student name is "Shashwat Abhale", the file should be `Shashwat Abhale.jpg` or `Shashwat.jpg`
- Supported formats: `.jpg`, `.jpeg`, `.png`, `.bmp`, `.webp`

### 3. Database Setup
- Make sure MongoDB is running
- Student names in the database should match roster photo names
- You can have partial matches (e.g., "Shashwat" in filename will match "Shashwat Abhale" in database)

## How to Use

### Starting the Server
```bash
cd project
npm start
```
The server will run on `http://localhost:3000`

### For Teachers

1. **Login**
   - Go to `http://localhost:3000`
   - Select "Teacher" role
   - Enter your username and password

2. **Mark Attendance**
   - On the teacher dashboard, scroll to "Mark Attendance" section
   - Select the subject from the dropdown
   - Upload a classroom photo showing all students
   - Click "Mark Attendance"
   - The system will:
     - Detect all faces in the photo
     - Match them with roster photos
     - Mark present students automatically
     - Update attendance records in the database
   - A success message will show which students were detected
   - The page will reload after 2 seconds showing updated attendance

3. **View Student Attendance**
   - Scroll down to "Students Attendance Record" table
   - View attendance percentages for all subjects
   - Attendance is automatically calculated from class counts

### For Students

1. **Login**
   - Go to `http://localhost:3000`
   - Select "Student" role
   - Enter your username and password

2. **View Attendance**
   - See your attendance record with:
     - Number of classes attended
     - Total number of classes
     - Attendance percentage per subject

## How It Works

1. **Teacher uploads classroom image** → Saved to `attendance_images/`
2. **Node.js calls Python script** → Processes the image using InsightFace
3. **Python script detects faces** → Matches with roster photos
4. **CSV file generated** → Contains list of detected students
5. **Node.js reads CSV** → Updates MongoDB with attendance data
6. **Database updated** → Student records show new attendance counts

## Troubleshooting

### Python Script Not Running
- **Error:** "Failed to process attendance"
- **Solution:** 
  - Check if Python is installed: `python --version`
  - On Windows, try `py` instead of `python`
  - Ensure all Python packages are installed
  - Check the server console for detailed error messages

### No Students Detected
- **Check:** Student names in roster photos match database names
- **Check:** Classroom photo quality (good lighting, clear faces)
- **Check:** Students are facing the camera
- **Adjust:** Lower the threshold in `attendance_system.py` (default: 0.38)

### Attendance Not Updating
- **Check:** MongoDB connection in server console
- **Check:** Student names in CSV match database exactly (case-sensitive)
- **Check:** Server console for error messages

### File Path Issues (Windows)
- Ensure paths use backslashes or forward slashes correctly
- Python script paths should be absolute or relative to project root

## Configuration

### Changing Attendance Threshold
Edit `attendance_system.py` line 166:
```python
parser.add_argument('--threshold', type=float, default=0.38, ...)
```
- Lower value (e.g., 0.30) = More lenient matching
- Higher value (e.g., 0.45) = Stricter matching

### Changing Subjects
Edit `project/server.js` line 186:
```javascript
const subjects = ["Digital Signal Processing", "Linear Integrated Circuits", ...];
```

## Features

✅ Automatic face detection and recognition  
✅ Attendance percentage calculation  
✅ Class count tracking (attended/total)  
✅ Real-time attendance updates  
✅ Preview images with face detection boxes  
✅ CSV export for attendance records  
✅ Secure teacher/student login system  
✅ Responsive web interface  

## Notes

- First run creates `roster_embeddings.json` cache (speeds up future runs)
- Each attendance marking creates a new CSV file with timestamp
- Preview images show detected faces with bounding boxes
- Student names must match between roster photos and database for accurate matching

