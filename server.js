const express = require("express");
const multer = require("multer");
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");

const app = express();

const PORT = process.env.PORT || 5000;

const DB_HOST = process.env.DB_HOST || "127.0.0.1";
const DB_PORT = process.env.DB_PORT || "3306";
const DB_USER = process.env.DB_USER;
const DB_PASSWORD = process.env.DB_PASSWORD;
const DB_NAME = process.env.DB_NAME;
const BUCKET_NAME = process.env.BUCKET_NAME;

if (!DB_USER || !DB_PASSWORD || !DB_NAME || !BUCKET_NAME) {
    console.error("Required environment variables are missing");
    console.error("Required: DB_USER, DB_PASSWORD, DB_NAME, BUCKET_NAME");
    process.exit(1);
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static("public"));

const uploadDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

/*
  No Google service account JSON key is used.
  GCS access uses Workload Identity through the Pod's Kubernetes ServiceAccount.
*/
const storageClient = new Storage();

let pool;

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function initializeDatabase() {
    const createTableSql = `
        CREATE TABLE IF NOT EXISTS assignments (
            id INT AUTO_INCREMENT PRIMARY KEY,
            student_name VARCHAR(100) NOT NULL,
            roll_number VARCHAR(50) NOT NULL,
            subject_name VARCHAR(100) NOT NULL,
            assignment_title VARCHAR(200) NOT NULL,
            assignment_date DATE,
            file_name VARCHAR(255),
            gcs_path VARCHAR(500),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `;

    await pool.query(createTableSql);

    const [columns] = await pool.query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = ?
          AND TABLE_NAME = 'assignments'
          AND COLUMN_NAME = 'assignment_date'
    `, [DB_NAME]);

    if (columns.length === 0) {
        await pool.query("ALTER TABLE assignments ADD COLUMN assignment_date DATE AFTER assignment_title");
        console.log("assignment_date column added");
    }

    console.log("Assignments table is ready");
}

async function connectToDatabaseWithRetry() {
    const maxAttempts = 30;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            pool = mysql.createPool({
                host: DB_HOST,
                port: Number(DB_PORT),
                user: DB_USER,
                password: DB_PASSWORD,
                database: DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0
            });

            await pool.query("SELECT 1");
            console.log("Connected to Cloud SQL MySQL through Auth Proxy");

            await initializeDatabase();
            return;
        } catch (error) {
            console.error("Database connection attempt " + attempt + " failed");
            console.error(error.message);

            if (attempt === maxAttempts) {
                console.error("Could not connect to database after retries");
                process.exit(1);
            }

            await sleep(5000);
        }
    }
}

const diskStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const cleanName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
        cb(null, Date.now() + "-" + cleanName);
    }
});

const upload = multer({
    storage: diskStorage,
    limits: {
        fileSize: 10 * 1024 * 1024
    }
});

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

app.get("/db-test", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT 1 AS cloud_sql_connection_test");

        res.json({
            message: "Cloud SQL connection successful",
            result: rows
        });
    } catch (error) {
        res.status(500).json({
            message: "Cloud SQL connection failed",
            error: error.message
        });
    }
});

app.get("/gcs-test", async (req, res) => {
    try {
        const [files] = await storageClient.bucket(BUCKET_NAME).getFiles({
            maxResults: 5
        });

        res.json({
            message: "GCS access successful using Workload Identity",
            bucket: BUCKET_NAME,
            files: files.map(file => file.name)
        });
    } catch (error) {
        res.status(500).json({
            message: "GCS access failed",
            error: error.message
        });
    }
});

app.post("/submit", upload.single("assignmentFile"), async (req, res) => {
    try {
        const studentName = req.body.studentName;
        const rollNumber = req.body.rollNumber;
        const subject = req.body.subject;
        const assignmentTitle = req.body.assignmentTitle;
        const assignmentDate = req.body.assignmentDate;

        if (!assignmentDate) {
            return res.status(400).json({
                message: "Assignment date is required"
            });
        }

        if (!req.file) {
            return res.status(400).json({
                message: "Assignment file is required"
            });
        }

        const localFilePath = req.file.path;
        const fileName = req.file.filename;
        const gcsObjectName = "assignments/" + fileName;

        await storageClient.bucket(BUCKET_NAME).upload(localFilePath, {
            destination: gcsObjectName
        });

        const gcsPath = "gs://" + BUCKET_NAME + "/" + gcsObjectName;

        const sql = `
            INSERT INTO assignments
            (
                student_name,
                roll_number,
                subject_name,
                assignment_title,
                assignment_date,
                file_name,
                gcs_path
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;

        await pool.query(sql, [
            studentName,
            rollNumber,
            subject,
            assignmentTitle,
            fileName,
            gcsPath
        ]);

        fs.unlink(localFilePath, () => {});

        res.json({
            message: "Assignment stored successfully"
        });
    } catch (error) {
        res.status(500).json({
            message: "Upload Failed",
            error: error.message
        });
    }
});

app.get("/assignments", async (req, res) => {
    try {
        const [rows] = await pool.query("SELECT * FROM assignments ORDER BY id DESC");
        res.json(rows);
    } catch (error) {
        res.status(500).json({
            message: error.message
        });
    }
});

connectToDatabaseWithRetry().then(() => {
    app.listen(PORT, "0.0.0.0", () => {
        console.log("Student Assignment Portal running on port " + PORT);
    });
});
