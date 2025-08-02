const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const cors = require("cors");
const helmet = require("helmet");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const AdmZip = require("adm-zip");

const app = express();
const PORT = process.env.PORT || 3000;
const maxSize = 2 * 1024 * 1024; // 2 MB

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, "uploads");
const outputDir = path.join(__dirname, "output");

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 1.5 * 1024 * 1024 * 1024 }, // 1.5GB limit
});

// Convert PNG to WebP with quality optimization
async function convertToWebP(buffer, quality = 90) {
  if (quality < 10) {
    throw new Error("Could not compress image under 2MB");
  }

  const webpBuffer = await sharp(buffer)
    .webp({ quality: quality, lossless: false })
    .toBuffer();

  if (webpBuffer.length > maxSize) {
    return convertToWebP(buffer, quality - 10);
  }

  return webpBuffer;
}

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Figma Plugin Backend API",
    version: "1.0.0",
  });
});

// Single file conversion endpoint
app.post("/convert-single", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const webpBuffer = await convertToWebP(req.file.buffer);
    const filename = `${path.parse(req.file.originalname).name}.webp`;

    res.set({
      "Content-Type": "image/webp",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });

    res.send(webpBuffer);
  } catch (error) {
    console.error("Conversion error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Batch conversion endpoint for Figma plugin
app.post("/convert-batch", async (req, res) => {
  try {
    const { files } = req.body;

    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: "Invalid files data" });
    }

    const convertedFiles = [];

    for (const file of files) {
      try {
        // Convert base64 to buffer
        const buffer = Buffer.from(file.data, "base64");

        // Convert to WebP
        const webpBuffer = await convertToWebP(buffer);

        // Change extension to .webp
        const webpPath = file.path.replace(/\.png$/i, ".webp");

        convertedFiles.push({
          path: webpPath,
          data: webpBuffer.toString("base64"),
          size: webpBuffer.length,
        });

        console.log(`Converted: ${file.path} -> ${webpPath}`);
      } catch (error) {
        console.error(`Error converting ${file.path}:`, error);
        // Continue with other files even if one fails
      }
    }

    res.json({
      success: true,
      files: convertedFiles,
      message: `Converted ${convertedFiles.length} files`,
    });
  } catch (error) {
    console.error("Batch conversion error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to create and download zip with converted files
app.post("/convert-and-zip", async (req, res) => {
  try {
    const { files, gameName = "game" } = req.body;

    if (!files || !Array.isArray(files)) {
      return res.status(400).json({ error: "Invalid files data" });
    }

    // This would require additional zip library
    // For now, return converted files data
    const convertedFiles = [];

    for (const file of files) {
      try {
        const buffer = Buffer.from(file.data, "base64");
        const webpBuffer = await convertToWebP(buffer);
        const webpPath = file.path.replace(/\.png$/i, ".webp");

        convertedFiles.push({
          path: webpPath,
          data: webpBuffer.toString("base64"),
        });
      } catch (error) {
        console.error(`Error converting ${file.path}:`, error);
      }
    }

    res.json({
      success: true,
      files: convertedFiles,
      gameName: gameName,
    });
  } catch (error) {
    console.error("Convert and zip error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Async processing with job tracking
const processingJobs = new Map();

// Start conversion job (async)
app.post(
  "/convert-folder-structure",
  upload.single("zipFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No zip file uploaded" });
      }

      const jobId = Date.now().toString();

      // Immediately return job ID and end response
      res.json({
        jobId: jobId,
        status: "processing",
        message: "Conversion started. Use /status endpoint to check progress.",
      });
      res.end();

      // Process asynchronously with small delay to ensure response is sent
      setImmediate(() => {
        processFilesAsync(jobId, req.file.buffer);
      });
    } catch (error) {
      console.error("Job creation error:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  }
);

// Check job status
app.get("/status/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = processingJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: "Job not found" });
  }

  res.json(job);
});

// List all active jobs (for monitoring)
app.get("/jobs", (req, res) => {
  const jobs = Array.from(processingJobs.entries()).map(([id, job]) => ({
    jobId: id,
    status: job.status,
    progress: job.progress,
    processedFiles: job.processedFiles || 0,
    totalFiles: job.totalFiles || 0,
  }));
  res.json({
    activeJobs: jobs.length,
    jobs: jobs,
    memoryUsage: process.memoryUsage(),
  });
});

// Download completed file
app.get("/download/:jobId", (req, res) => {
  const jobId = req.params.jobId;
  const job = processingJobs.get(jobId);

  if (!job || job.status !== "completed") {
    return res.status(404).json({ error: "File not ready" });
  }

  try {
    const zipBuffer = fs.readFileSync(job.outputPath);

    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="converted_images.zip"',
      "Content-Length": zipBuffer.length,
    });

    res.send(zipBuffer);

    // Clean up after download
    setTimeout(() => {
      processingJobs.delete(jobId);
      if (fs.existsSync(job.tempDir)) {
        fs.rmSync(job.tempDir, { recursive: true, force: true });
      }
    }, 5000);
  } catch (error) {
    res.status(500).json({ error: "Download failed" });
  }
});

// Async processing function
async function processFilesAsync(jobId, fileBuffer) {
  const tempDir = path.join(__dirname, "temp", jobId);
  const extractDir = path.join(tempDir, "extracted");
  const outputDir = path.join(tempDir, "output");
  const outputZipPath = path.join(tempDir, "converted.zip");

  try {
    // Update job status
    processingJobs.set(jobId, {
      status: "extracting",
      progress: 0,
      tempDir: tempDir,
      outputPath: outputZipPath,
    });

    fs.mkdirSync(extractDir, { recursive: true });
    fs.mkdirSync(outputDir, { recursive: true });

    // Extract zip
    const zip = new AdmZip(fileBuffer);
    zip.extractAllTo(extractDir, true);

    processingJobs.set(jobId, {
      status: "converting",
      progress: 10,
      tempDir: tempDir,
      outputPath: outputZipPath,
    });

    // Count total PNG files for progress tracking
    let totalPngs = 0;
    let processedPngs = 0;

    function countPngs(dir) {
      const items = fs.readdirSync(dir);
      for (const item of items) {
        const itemPath = path.join(dir, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          countPngs(itemPath);
        } else if (path.extname(item).toLowerCase() === ".png") {
          totalPngs++;
        }
      }
    }

    countPngs(extractDir);

    // Process directory with progress updates
    async function processDirectory(sourceDir, outputDir) {
      const items = fs.readdirSync(sourceDir);

      for (const item of items) {
        const sourcePath = path.join(sourceDir, item);
        const outputPath = path.join(outputDir, item);
        const stat = fs.statSync(sourcePath);

        if (stat.isDirectory()) {
          fs.mkdirSync(outputPath, { recursive: true });
          await processDirectory(sourcePath, outputPath);
        } else if (
          stat.isFile() &&
          path.extname(item).toLowerCase() === ".png"
        ) {
          try {
            const fileBuffer = fs.readFileSync(sourcePath);
            const webpBuffer = await convertToWebP(fileBuffer);
            const webpFileName = path.parse(item).name + ".webp";
            const webpPath = path.join(outputDir, webpFileName);
            fs.writeFileSync(webpPath, webpBuffer);

            processedPngs++;
            const progress = Math.min(
              90,
              10 + Math.floor((processedPngs / totalPngs) * 70)
            );

            processingJobs.set(jobId, {
              status: "converting",
              progress: progress,
              processedFiles: processedPngs,
              totalFiles: totalPngs,
              tempDir: tempDir,
              outputPath: outputZipPath,
            });

            console.log(
              `[${jobId}] Converted ${processedPngs}/${totalPngs}: ${item}`
            );

            // Force garbage collection hints for memory management
            if (processedPngs % 3 === 0 && global.gc) {
              global.gc();
            }

            // Small delay every 5 files to prevent overwhelming the system
            if (processedPngs % 5 === 0) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } catch (conversionError) {
            console.error(
              `[${jobId}] Failed to convert ${item}:`,
              conversionError.message
            );
            // Continue with other files
          }
        } else {
          fs.copyFileSync(sourcePath, outputPath);
        }
      }
    }

    await processDirectory(extractDir, outputDir);

    // Create zip
    processingJobs.set(jobId, {
      status: "zipping",
      progress: 90,
      tempDir: tempDir,
      outputPath: outputZipPath,
    });

    const outputZip = new AdmZip();

    function addDirectoryToZip(dirPath, zipPath = "") {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        const itemPath = path.join(dirPath, item);
        const stat = fs.statSync(itemPath);
        if (stat.isDirectory()) {
          addDirectoryToZip(itemPath, path.join(zipPath, item));
        } else {
          outputZip.addLocalFile(itemPath, zipPath);
        }
      }
    }

    addDirectoryToZip(outputDir);
    outputZip.writeZip(outputZipPath);

    // Mark as completed
    processingJobs.set(jobId, {
      status: "completed",
      progress: 100,
      processedFiles: processedPngs,
      totalFiles: totalPngs,
      tempDir: tempDir,
      outputPath: outputZipPath,
      downloadUrl: `/download/${jobId}`,
    });

    console.log(
      `[${jobId}] Conversion completed: ${processedPngs} files processed`
    );
  } catch (error) {
    console.error(`[${jobId}] Processing error:`, error);
    processingJobs.set(jobId, {
      status: "failed",
      error: error.message,
      tempDir: tempDir,
    });

    // Clean up on error
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError);
    }
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}`);
});

module.exports = app;
