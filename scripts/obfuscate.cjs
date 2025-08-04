const JavaScriptObfuscator = require('javascript-obfuscator');
const fs = require('fs');
const path = require('path');

// Obfuscation options
const obfuscationOptions = {
  // String encoding (lighter)
  stringArray: true,
  stringArrayRotate: false,
  stringArrayShuffle: false,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: false,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.5,

  // Control flow (lighter)
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.3,
  deadCodeInjection: false,
  deadCodeInjectionThreshold: 0,

  // Variable names (shorter)
  identifierNamesGenerator: 'mangled-shuffled',
  renameGlobals: false,
  renameProperties: false,
  renamePropertiesMode: 'safe',

  // Function names
  transformObjectKeys: true,
  unicodeEscapeSequence: false,

  // General
  compact: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 5,

  // Self defending
  selfDefending: true,
  debugProtection: true,
  debugProtectionInterval: 2000,
  disableConsoleOutput: false,

  // Advanced
  domainLock: [],
  reservedNames: [],
  reservedStrings: [],
  seed: 0,
  sourceMap: false,
  target: 'browser'
};

// Files to obfuscate
const filesToObfuscate = [
  'dist/sip-worker.worker.js',
  'dist/sw.js',
  'public/sw.js'
];

function obfuscateFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`❌ File not found: ${filePath}`);
      return;
    }

    console.log(`🔒 Obfuscating: ${filePath}`);

    const sourceCode = fs.readFileSync(filePath, 'utf8');
    const obfuscationResult = JavaScriptObfuscator.obfuscate(sourceCode, obfuscationOptions);

    // Create backup
    const backupPath = filePath + '.original';
    if (!fs.existsSync(backupPath)) {
      fs.writeFileSync(backupPath, sourceCode);
      console.log(`📋 Backup created: ${backupPath}`);
    }

    // Write obfuscated code
    fs.writeFileSync(filePath, obfuscationResult.getObfuscatedCode());
    console.log(`✅ Obfuscated: ${filePath}`);

  } catch (error) {
    console.error(`❌ Error obfuscating ${filePath}:`, error.message);
  }
}

function restoreFile(filePath) {
  try {
    const backupPath = filePath + '.original';
    if (fs.existsSync(backupPath)) {
      const originalCode = fs.readFileSync(backupPath, 'utf8');
      fs.writeFileSync(filePath, originalCode);
      console.log(`🔄 Restored: ${filePath}`);
    } else {
      console.log(`❌ No backup found for: ${filePath}`);
    }
  } catch (error) {
    console.error(`❌ Error restoring ${filePath}:`, error.message);
  }
}

// Command line arguments
const command = process.argv[2];

if (command === 'restore') {
  console.log('🔄 Restoring original files...');
  filesToObfuscate.forEach(restoreFile);
} else {
  console.log('🔒 Starting obfuscation process...');
  filesToObfuscate.forEach(obfuscateFile);
  console.log('✅ Obfuscation completed!');
}
