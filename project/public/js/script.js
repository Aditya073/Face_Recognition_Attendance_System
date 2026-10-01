document.addEventListener("DOMContentLoaded", () => {
    const loginForm = document.getElementById("loginForm");
    const errorMessage = document.getElementById("errorMessage");

    if (loginForm) {
        loginForm.addEventListener("submit", function(event) {
            // No preventDefault() - let the form submit to server
            // Optional: Basic client-side validation if needed
            const username = document.getElementById("username").value.trim();
            const password = document.getElementById("password").value.trim();
            const role = document.getElementById("role").value;

            if (!username || !password || !role) {
                event.preventDefault();
                errorMessage.textContent = "Please fill all fields!";
                return;
            }
            // Form will submit to /login
        });
    }

    // Attendance alert check (for student page) .....................................................
    const attendancePercent = document.getElementById("attendancePercent");
    const alertMessage = document.getElementById("alertMessage");
    if (attendancePercent) {
        let percentValue = parseInt(attendancePercent.textContent);
        if (percentValue < 75) {
            alertMessage.textContent = "⚠ Low attendance! Please attend more lectures.";
        } else {
            alertMessage.textContent = "";
        }
    }
});

function updatePhoto() {
    alert("Photo update feature will be connected to backend later.");
}