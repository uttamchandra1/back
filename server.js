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

// Recursive folder structure conversion endpoint
app.post(
  "/convert-folder-structure",
  upload.single("zipFile"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No zip file uploaded" });
      }

      // Create temporary directories for processing
      const tempDir = path.join(__dirname, "temp", Date.now().toString());
      const extractDir = path.join(tempDir, "extracted");
      const outputDir = path.join(tempDir, "output");

      fs.mkdirSync(extractDir, { recursive: true });
      fs.mkdirSync(outputDir, { recursive: true });

      try {
        // Extract uploaded zip file
        const zip = new AdmZip(req.file.buffer);
        zip.extractAllTo(extractDir, true);

        // Function to recursively find PNG files and convert them
        async function processDirectory(sourceDir, outputDir) {
          const items = fs.readdirSync(sourceDir);

          for (const item of items) {
            const sourcePath = path.join(sourceDir, item);
            const outputPath = path.join(outputDir, item);
            const stat = fs.statSync(sourcePath);

            if (stat.isDirectory()) {
              // Create directory in output and recurse
              fs.mkdirSync(outputPath, { recursive: true });
              await processDirectory(sourcePath, outputPath);
            } else if (
              stat.isFile() &&
              path.extname(item).toLowerCase() === ".png"
            ) {
              // Convert PNG to WebP
              const fileBuffer = fs.readFileSync(sourcePath);
              const webpBuffer = await convertToWebP(fileBuffer);
              const webpFileName = path.parse(item).name + ".webp";
              const webpPath = path.join(outputDir, webpFileName);
              fs.writeFileSync(webpPath, webpBuffer);
              console.log(`Converted: ${sourcePath} -> ${webpPath}`);
            } else {
              // Copy non-PNG files as-is
              fs.copyFileSync(sourcePath, outputPath);
            }
          }
        }

        // Process the extracted directory
        await processDirectory(extractDir, outputDir);

        // Create output zip
        const outputZip = new AdmZip();

        // Function to add directory to zip recursively
        function addDirectoryToZip(dirPath, zipPath = "") {
          const items = fs.readdirSync(dirPath);

          for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const zipItemPath = path.join(zipPath, item);
            const stat = fs.statSync(itemPath);

            if (stat.isDirectory()) {
              addDirectoryToZip(itemPath, zipItemPath);
            } else {
              outputZip.addLocalFile(itemPath, zipPath);
            }
          }
        }

        addDirectoryToZip(outputDir);

        const zipBuffer = outputZip.toBuffer();

        // Set response headers for zip download
        res.set({
          "Content-Type": "application/zip",
          "Content-Disposition": 'attachment; filename="converted_images.zip"',
          "Content-Length": zipBuffer.length,
        });

        res.send(zipBuffer);
      } finally {
        // Clean up temporary files
        if (fs.existsSync(tempDir)) {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
    } catch (error) {
      console.error("Folder structure conversion error:", error);
      res.status(500).json({ error: error.message });
    }
  }
);

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
