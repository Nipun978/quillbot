import fs from 'node:fs/promises';
import path from 'node:path';

export function getBackupDir(cwd = process.cwd()) {
  return path.join(cwd, '.quillbot', 'backups');
}

/**
 * Creates a safety backup of a file before editing or modifying it.
 * Preserves historical versions so previous files are never ruined or lost.
 */
export async function createBackup(filePath, cwd = process.cwd()) {
  try {
    // Check if original file exists
    await fs.access(filePath);
  } catch {
    // File doesn't exist yet (e.g. newly created file), no backup needed
    return null;
  }

  try {
    const backupDir = getBackupDir(cwd);
    await fs.mkdir(backupDir, { recursive: true });

    const baseName = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 17);
    const uniqueSuffix = Date.now().toString().slice(-4);
    const backupFileName = `${baseName}.${timestamp}_${uniqueSuffix}.bak`;
    const backupPath = path.join(backupDir, backupFileName);

    await fs.copyFile(filePath, backupPath);
    return backupPath;
  } catch (err) {
    console.error(`[Backup Warning] Could not create backup for ${filePath}: ${err.message}`);
    return null;
  }
}
