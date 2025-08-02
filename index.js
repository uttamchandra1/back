const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const inputDir = path.join(__dirname, "inamedyounothing");
const outputDir = path.join(__dirname, "inamedyounothingwebp");
const maxSize = 2 * 1024 * 1024; // 2 MB

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

async function convertWithQuality(inputPath, outputPath, quality) {
  if (quality < 10) {
    // Stop if quality is too low
    console.warn(`Could not compress ${path.basename(inputPath)} under 2MB.`);
    return;
  }

  const data = await sharp(inputPath)
    .webp({ quality: quality, lossless: false })
    .toBuffer();

  if (data.length > maxSize) {
    // If still too large, reduce quality and try again
    await convertWithQuality(inputPath, outputPath, quality - 10);
  } else {
    // Ensure output directory exists
    const outputDirPath = path.dirname(outputPath);
    if (!fs.existsSync(outputDirPath)) {
      fs.mkdirSync(outputDirPath, { recursive: true });
    }

    fs.writeFile(outputPath, data, (err) => {
      if (err) {
        console.error(`Error saving ${path.basename(outputPath)}:`, err);
      } else {
        console.log(
          `Successfully converted ${path.basename(
            inputPath
          )} to ${path.basename(outputPath)} with quality ${quality}`
        );
      }
    });
  }
}

// Recursive function to process directories
async function processDirectory(currentInputDir, currentOutputDir) {
  const items = fs.readdirSync(currentInputDir);

  for (const item of items) {
    const inputPath = path.join(currentInputDir, item);
    const stat = fs.statSync(inputPath);

    if (stat.isDirectory()) {
      // If it's a directory, recursively process it
      const newOutputDir = path.join(currentOutputDir, item);
      console.log(`Processing directory: ${item}`);
      await processDirectory(inputPath, newOutputDir);
    } else if (stat.isFile() && path.extname(item).toLowerCase() === ".png") {
      // If it's a PNG file, convert it
      const outputFilename = `${path.parse(item).name}.webp`;
      const outputPath = path.join(currentOutputDir, outputFilename);

      console.log(`Converting: ${inputPath} -> ${outputPath}`);
      await convertWithQuality(inputPath, outputPath, 90); // Start with quality 90
    }
  }
}

// Start the conversion process
console.log(`Starting conversion from ${inputDir} to ${outputDir}`);
processDirectory(inputDir, outputDir)
  .then(() => {
    console.log("Conversion process completed!");
  })
  .catch((err) => {
    console.error("Error during conversion:", err);
  });
