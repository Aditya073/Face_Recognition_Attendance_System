# Quick Start Guide

## Installation Steps

1. **Install Node.js dependencies:**
   ```bash
   cd project
   npm install
   ```

2. **Install Python dependencies:**
   ```bash
   pip install opencv-python numpy insightface
   ```

3. **Ensure MongoDB is running:**
   - Default: `mongodb://localhost:27017`

4. **Start the server:**
   ```bash
   cd project
   npm start
   ```

5. **Access the portal:**
   - Open browser: `http://localhost:3000`

## First Time Setup

### Teacher Login
- Login with your teacher credentials
- Upload a classroom photo to mark attendance
- Select subject from dropdown
- Wait for processing (may take 30-60 seconds)

### Student Login  
- Login with your student credentials
- View your attendance record

## Important Notes

### Name Matching
- Roster photo names should match student database names
- Example: If DB has "Shashwat Abhale", roster can have:
  - `Shashwat Abhale.jpg` ✅ (best)
  - `Shashwat.jpg` ✅ (works - uses first name)
- The system tries to match using first name if full name doesn't match

### Directory Structure
Make sure these directories exist (auto-created if missing):
- `roster/` - Student photos for face recognition
- `attendance_output/` - Generated CSV files and preview images
- `attendance_images/` - Uploaded classroom photos
- `project/public/uploads/` - Profile photos

## Testing

1. **Test with a sample classroom photo:**
   - Take/use a photo with multiple students
   - Ensure good lighting and clear faces
   - Upload via teacher dashboard

2. **Check results:**
   - View attendance table on teacher dashboard
   - Check individual student records
   - Verify CSV files in `attendance_output/`

## Troubleshooting

- **"Failed to process attendance"** → Check Python installation and packages
- **"No students detected"** → Check photo quality and name matching
- **"MongoDB connection error"** → Ensure MongoDB is running

For detailed information, see `INTEGRATION_GUIDE.md`

