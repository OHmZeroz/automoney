/**
 * ==============================================================================
 * KMITL CLASS PAYMENT SYSTEM - GOOGLE APPS SCRIPT BACKEND (LINE LOGIN VERSION)
 * ==============================================================================
 * 
 * Instructions for setup (วิธีติดตั้ง):
 * 1. เปิด Google Sheet: https://docs.google.com/spreadsheets/d/1fl2GOuz-VgXiXLKlB9SVDE_lEdOuI6bp6Y4MS5lvffs/edit
 * 2. ไปที่เมนู "ส่วนขยาย" (Extensions) -> "Apps Script"
 * 3. ลบโค้ดเก่าใน Apps Script ออกให้หมด แล้ววางโค้ดนี้ลงไปแทน
 * 4. กดปุ่มบันทึกโครงการ (รูปแผ่นดิสก์)
 * 5. กดปุ่ม "ทำให้ใช้งานได้อย่างเป็นทางการ" (Deploy) -> "การทำให้ใช้งานได้อย่างเป็นทางการรายการใหม่" (New deployment)
 *    - ประเภท: "เว็บแอป" (Web app)
 *    - การกำหนดค่า (Execute as): "ฉัน" (Me / อีเมลของคุณ)
 *    - ผู้เข้าถึง (Who has access): "ทุกคน" (Anyone)
 * 6. คัดลอก "URL ของเว็บแอป" (Web App URL) นำมาใส่ในปุ่ม "⚙️ ตั้งค่าเชื่อมต่อ Google" บนหน้าเว็บ
 */

const CONFIG = {
  SPREADSHEET_ID: '1fl2GOuz-VgXiXLKlB9SVDE_lEdOuI6bp6Y4MS5lvffs',
  FOLDER_ID: '1vVmoWgVS3V0ASdY3TYhSY76kgFYjBV57',
  PAYMENTS_SHEET_NAME: 'รายการชำระเงิน',
  STUDENT_SHEET_NAME: 'รายชื่อนักศึกษา',
  LINE_BOT_ACCESS_TOKEN: 'Q2+G1oD4asgbuGOrq2xArMEVhKIVJ9AW2g8xCvU8wN4uT1oMW3RJX1po720DL4f6sec4A5wmaQBu5+O3+jRdBZKVT3LmEC0bOkxP2adqviJayaMiV8Ryjk6CwWNgcSCz17/0a3XDrdlY6HF8sJ6MZAdB04t89/1O/w1cDnyilFU='
};

/**
 * Helper to get current active spreadsheet or fallback by ID
 */
function getSpreadsheet() {
  try {
    const active = SpreadsheetApp.getActiveSpreadsheet();
    if (active) return active;
  } catch (e) {}
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

/**
 * [สำคัญ] รันฟังก์ชันนี้ 1 ครั้งในหน้า Apps Script เพื่อให้ Google ขึ้นปุ่มปลดล็อกสิทธิ์ UrlFetchApp (LINE API)!
 */
function authorizeExternalRequests() {
  try {
    UrlFetchApp.fetch("https://api.line.me");
  } catch(e) {
    Logger.log("Authorized!");
  }
}

/**
 * Handle HTTP GET Requests
 */
function doGet(e) {
  try {
    const action = e.parameter.action;

    // --- Action 1: LINE OAuth Token Exchange & Login Verification ---
    if (action === 'lineLogin') {
      const code = e.parameter.code;
      const redirectUri = e.parameter.redirect_uri;
      const channelId = e.parameter.channelId;
      const channelSecret = e.parameter.channelSecret;

      if (!code || !channelId || !channelSecret) {
        return createJsonResponse({ status: 'error', message: 'ข้อมูลสำหรับ LINE Login ไม่ครบถ้วน (เช็คการตั้งค่าในแผงเหรัญญิก)' });
      }

      // 1.1 Exchange Auth Code for Access Token
      const tokenResult = exchangeLineCodeForToken(code, redirectUri, channelId, channelSecret);
      if (tokenResult.error) {
        return createJsonResponse({ status: 'error', message: 'LINE Token Exchange Failed: ' + tokenResult.error_description });
      }

      // 1.2 Fetch LINE User Profile
      const profile = fetchLineUserProfile(tokenResult.access_token);
      if (profile.error) {
        return createJsonResponse({ status: 'error', message: 'LINE Profile Fetch Failed: ' + profile.error });
      }

      // 1.3 Check if this LINE User ID is already linked to a Student ID in Sheet
      const studentInfo = findStudentByLineUserId(profile.userId);
      if (studentInfo) {
        return createJsonResponse({
          status: 'success',
          registered: true,
          lineUserId: profile.userId,
          name: studentInfo.name,
          studentId: studentInfo.studentId,
          picture: profile.pictureUrl || ''
        });
      } else {
        return createJsonResponse({
          status: 'success',
          registered: false,
          lineUserId: profile.userId,
          lineName: profile.displayName
        });
      }
    }

    // --- Action 1.5: Check LINE User ID directly (for LINE LIFF) ---
    if (action === 'checkLineUser') {
      const lineUserId = e.parameter.lineUserId;
      if (!lineUserId) {
        return createJsonResponse({ status: 'error', message: 'ไม่พบ lineUserId' });
      }

      const studentInfo = findStudentByLineUserId(lineUserId);
      if (studentInfo) {
        return createJsonResponse({
          status: 'success',
          registered: true,
          lineUserId: lineUserId,
          name: studentInfo.name,
          studentId: studentInfo.studentId
        });
      } else {
        return createJsonResponse({
          status: 'success',
          registered: false,
          lineUserId: lineUserId
        });
      }
    }

    // --- Action 2: Direct Check Student ID (Bypass Login) ---
    if (action === 'checkStudentId') {
      const studentId = e.parameter.studentId;
      const studentName = getStudentNameById(studentId);
      if (studentName) {
        return createJsonResponse({
          status: 'success',
          exists: true,
          name: studentName
        });
      } else {
        return createJsonResponse({
          status: 'success',
          exists: false
        });
      }
    }

    // --- Action 3: Get Fee Items List ---
    if (action === 'getFeeItems') {
      const items = getOrCreateFeeItemsSheet();
      return createJsonResponse({ status: 'success', data: items });
    }

    // Default: Get all payments (for admin verification panel)
    const sheet = getOrCreatePaymentsSheet();
    const data = sheet.getDataRange().getValues();
    if (data.length <= 1) {
      return createJsonResponse({ status: 'success', data: [] });
    }
    const headers = data[0];
    const rows = data.slice(1).map(row => {
      let obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i];
      });
      return obj;
    });

    return createJsonResponse({
      status: 'success',
      data: rows
    });

  } catch (error) {
    return createJsonResponse({
      status: 'error',
      message: error.toString()
    });
  }
}

/**
 * Handle HTTP POST Requests
 */
function doPost(e) {
  try {
    let contents = {};

    // --- Method 1: Parse from hidden form input named 'payload' (form/iframe method) ---
    if (e && e.parameter && e.parameter.payload) {
      try {
        contents = JSON.parse(e.parameter.payload);
      } catch (err) {
        Logger.log('Error parsing e.parameter.payload: ' + err.toString());
      }
    }
    // --- Method 2: Parse from raw POST body (fetch method) ---
    else if (e && e.postData && e.postData.contents) {
      if (typeof e.postData.contents === 'string') {
        try {
          contents = JSON.parse(e.postData.contents);
        } catch (err) {
          // Fallback: try e.parameter directly
          contents = (e && e.parameter) ? e.parameter : {};
        }
      } else if (typeof e.postData.contents === 'object') {
        contents = e.postData.contents;
      }
    }
    // --- Method 3: Fallback to e.parameter ---
    else if (e && e.parameter) {
      contents = e.parameter;
    }

    // Debug log to see what data was received
    Logger.log('doPost received action: ' + (contents.action || 'NO_ACTION'));
    Logger.log('doPost contents keys: ' + Object.keys(contents).join(', '));

    const action = contents.action;

    // --- Action 1: Link LINE User ID to Student ID in Sheet ---
    if (action === 'registerLineUser') {
      const lineUserId = contents.lineUserId;
      const studentId = contents.studentId;
      const lineName = contents.lineName || 'LINE User';

      if (!lineUserId || !studentId) {
        return createJsonResponse({ status: 'error', message: 'ข้อมูลเชื่อมโยงบัญชีไม่ครบถ้วน' });
      }

      const result = linkLineIdToStudent(lineUserId, studentId);
      return createJsonResponse(result);
    }

    // --- Action 1.5: Update Payment Status (Approved/Rejected) ---
    if (action === 'updatePaymentStatus') {
      const studentId = contents.studentId;
      const feeName = contents.feeName;
      const status = contents.status;
      const result = updatePaymentStatusInSheet(studentId, feeName, status);
      return createJsonResponse(result);
    }

    // --- Action 2: Save New Fee Item to Sheet ---
    if (action === 'saveFeeItem') {
      let feeItem = contents.feeItem;
      // ถ้า feeItem มาเป็น JSON string (จาก form submission) ให้ parse ก่อน
      if (typeof feeItem === 'string') {
        try { feeItem = JSON.parse(feeItem); } catch(e) { Logger.log('feeItem parse error: ' + e); }
      }
      const result = saveFeeItemToSheet(feeItem);
      return createJsonResponse(result);
    }

    // --- Action 3: Delete Fee Item from Sheet ---
    if (action === 'deleteFeeItem') {
      const feeId = contents.feeId;
      const feeName = contents.feeName;
      const result = deleteFeeItemFromSheet(feeId, feeName);
      return createJsonResponse(result);
    }

    // --- Action 4: Submit Payment Slip (Save to Drive & Sheet) ---
    if (action === 'submitPayment' || !action) {
      Logger.log('Processing submitPayment...');
      const studentName = contents.studentName || 'ไม่ระบุชื่อ';
      const studentId = contents.studentId || contents.studentEmail || 'ไม่ระบุรหัส';
      const studentEmail = studentId;
      const feeName = contents.feeName || 'ค่าห้อง';
      const amount = contents.amount || 0;
      const slipBase64 = contents.slipBase64 || '';
      const qrRef = contents.qrRef || '-';
      const remark = contents.remark || '-';
      const timestamp = contents.timestamp || new Date().toLocaleString('th-TH');

      Logger.log('Student: ' + studentName + ', Fee: ' + feeName + ', Amount: ' + amount);

      let slipDriveUrl = 'https://drive.google.com/drive/folders/' + CONFIG.FOLDER_ID;

      if (slipBase64) {
        slipDriveUrl = saveSlipToDrive(studentId, feeName, slipBase64);
        Logger.log('Slip saved to Drive: ' + slipDriveUrl);
      }

      const sheet = getOrCreatePaymentsSheet();
      sheet.appendRow([
        timestamp,
        studentName,
        studentId,
        feeName,
        amount,
        'Pending',
        slipDriveUrl,
        qrRef,
        remark
      ]);
      SpreadsheetApp.flush();
      Logger.log('Payment row appended and flushed successfully!');

      // Send LINE Bot Push message to Admin (student ID 69010115)
      try {
        const adminLineId = getAdminLineUserId();
        if (adminLineId) {
          const pushMsg = `📢 มีการส่งสลิปชำระเงินใหม่!\n👤 นักศึกษา: ${studentName}\n🆔 รหัส: ${studentId}\n📚 รายการชำระ: ${feeName}\n💰 ยอดชำระ: ฿${amount}\n💬 หมายเหตุ: ${remark}\n📂 ลิงก์สลิป: ${slipDriveUrl}`;
          sendLinePushMessage(adminLineId, pushMsg);
        }
      } catch (err) {
        Logger.log('Line bot push error: ' + err.toString());
      }

      return createJsonResponse({
        status: 'success',
        message: 'บันทึกประวัติและสลิปเข้า Google Drive เรียบร้อยแล้ว',
        driveUrl: slipDriveUrl
      });
    }

    // --- Unknown Action ---
    Logger.log('Unknown action received: ' + action);
    return createJsonResponse({
      status: 'error',
      message: 'ไม่รู้จัก action: ' + (action || 'ไม่มี')
    });

  } catch (error) {
    return createJsonResponse({
      status: 'error',
      message: error.toString()
    });
  }
}

/**
 * Exchange Authorization Code for LINE Access Token
 */
function exchangeLineCodeForToken(code, redirectUri, channelId, channelSecret) {
  const url = 'https://api.line.me/oauth2/v2.1/token';
  const body = 'grant_type=authorization_code'
    + '&code=' + encodeURIComponent(code)
    + '&redirect_uri=' + encodeURIComponent(redirectUri)
    + '&client_id=' + encodeURIComponent(channelId)
    + '&client_secret=' + encodeURIComponent(channelSecret);
  
  const options = {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: body,
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

/**
 * Fetch LINE Profile using Access Token
 */
function fetchLineUserProfile(accessToken) {
  const url = 'https://api.line.me/v2/profile';
  const options = {
    method: 'get',
    headers: {
      'Authorization': 'Bearer ' + accessToken
    },
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  return JSON.parse(response.getContentText());
}

/**
 * Find student info by linked LINE User ID
 */
function findStudentByLineUserId(lineUserId) {
  if (!lineUserId) return null;
  const ss = getSpreadsheet();
  const sheet = getStudentSheet(ss);
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  const lineColIdx = findColumnIndex(headers, ['line id', 'line_id', 'line', 'ไลน์', 'ติดต่อ']);
  const idColIdx = findColumnIndex(headers, ['เลขประจำตัว', 'รหัสนักศึกษา', 'student id', 'id']);
  const nameColIdx = findColumnIndex(headers, ['ชื่อ-นามสกุล', 'ชื่อ', 'name']);

  if (lineColIdx === -1) return null;

  const cleanTargetLineId = lineUserId.toString().trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if (!data[i][lineColIdx]) continue;
    const cleanCellLineId = data[i][lineColIdx].toString().trim().toLowerCase();
    
    if (cleanCellLineId === cleanTargetLineId) {
      return {
        studentId: idColIdx !== -1 ? data[i][idColIdx].toString().trim() : '',
        name: nameColIdx !== -1 ? data[i][nameColIdx].toString().trim() : 'นักศึกษา KMITL'
      };
    }
  }
  return null;
}

/**
 * Link LINE User ID to official Student ID inside Sheet
 */
function linkLineIdToStudent(lineUserId, studentId) {
  const ss = getSpreadsheet();
  const sheet = getStudentSheet(ss);
  if (!sheet) {
    return { status: 'error', message: 'ไม่พบชีตรายชื่อนักศึกษาในระบบ' };
  }

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  const idColIdx = findColumnIndex(headers, ['เลขประจำตัว', 'รหัสนักศึกษา', 'student id', 'id']);
  let lineColIdx = findColumnIndex(headers, ['line id', 'line_id', 'line', 'ไลน์', 'ติดต่อ']);
  const nameColIdx = findColumnIndex(headers, ['ชื่อ-นามสกุล', 'ชื่อ', 'name']);

  if (idColIdx === -1) {
    return { status: 'error', message: 'โครงสร้างตารางไม่ถูกต้อง (ไม่พบหัวตาราง รหัสนักศึกษา/เลขประจำตัว)' };
  }

  // If LINE ID column does not exist in Sheet, automatically create it!
  if (lineColIdx === -1) {
    lineColIdx = headers.length;
    sheet.getRange(1, lineColIdx + 1).setValue('LINE ID');
  }

  const cleanSearchId = studentId.toString().split('.')[0].replace(/[^0-9a-zA-Z]/g, '').trim().toLowerCase();

  for (let i = 1; i < data.length; i++) {
    if (!data[i][idColIdx]) continue;
    const cleanRowId = data[i][idColIdx].toString().split('.')[0].replace(/[^0-9a-zA-Z]/g, '').trim().toLowerCase();
    
    if (cleanRowId === cleanSearchId) {
      const existingLineId = data[i][lineColIdx] ? data[i][lineColIdx].toString().trim() : '';

      // Check if already linked to a different LINE ID
      if (existingLineId && existingLineId.toLowerCase() !== lineUserId.trim().toLowerCase()) {
        return { status: 'error', message: 'รหัสนักศึกษานี้ถูกลงทะเบียนโดยบัญชี LINE อื่นไปแล้ว' };
      }

      // Link LINE User ID in sheet cell and flush immediately
      sheet.getRange(i + 1, lineColIdx + 1).setValue(lineUserId.trim());
      SpreadsheetApp.flush();
      
      const studentName = nameColIdx !== -1 ? data[i][nameColIdx].toString().trim() : 'นักศึกษา KMITL';
      return {
        status: 'success',
        message: 'เชื่อมต่อบัญชีสำเร็จ',
        name: studentName
      };
    }
  }

  // Auto-append new student row if student ID is not in sheet yet!
  sheet.appendRow([studentId, lineName || ('นักศึกษา รหัส ' + studentId), lineUserId.trim()]);
  SpreadsheetApp.flush();
  return { status: 'success', message: 'เชื่อมต่อบัญชีสำเร็จ', name: lineName || ('นักศึกษา รหัส ' + studentId) };
}

/**
 * Get student name by official Student ID or Name search
 */
function getStudentNameById(studentId) {
  const ss = getSpreadsheet();
  const sheet = getStudentSheet(ss);
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  
  const idColIdx = findColumnIndex(headers, ['เลขประจำตัว', 'รหัสนักศึกษา', 'student id', 'id']);
  const nameColIdx = findColumnIndex(headers, ['ชื่อ-นามสกุล', 'ชื่อ', 'name']);

  if (idColIdx === -1 || nameColIdx === -1) return null;

  const rawSearch = studentId.toString().trim().toLowerCase();
  const cleanSearchId = rawSearch.split('.')[0].replace(/[^0-9a-zA-Z]/g, '');

  for (let i = 1; i < data.length; i++) {
    if (!data[i][idColIdx]) continue;
    const rawRowId = data[i][idColIdx].toString().trim();
    const cleanRowId = rawRowId.split('.')[0].replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const rowName = nameColIdx !== -1 ? data[i][nameColIdx].toString().trim() : '';
    const cleanRowName = rowName.toLowerCase();

    // Match by ID OR match by Name
    if ((cleanSearchId && cleanRowId === cleanSearchId) || (rawSearch && cleanRowName.indexOf(rawSearch) !== -1)) {
      return rowName || ('นักศึกษา รหัส ' + rawRowId);
    }
  }
  return null;
}

/**
 * Helper to find column index from header aliases
 */
function findColumnIndex(headers, aliases) {
  for (let i = 0; i < headers.length; i++) {
    const headerStr = headers[i].toString().trim().toLowerCase();
    for (let alias of aliases) {
      if (headerStr.indexOf(alias.toLowerCase()) !== -1) {
        return i;
      }
    }
  }
  return -1;
}

/**
 * Helper to get the student list sheet (scans all sheets dynamically or auto-creates if missing)
 */
function getStudentSheet(ss) {
  // 1. Try search by name first
  let sheet = ss.getSheetByName(CONFIG.STUDENT_SHEET_NAME);
  if (sheet) return sheet;

  // 2. Loop through all sheets and find the one that has student id column
  const sheets = ss.getSheets();
  for (let s of sheets) {
    const dataRange = s.getDataRange();
    if (dataRange) {
      const values = dataRange.getValues();
      if (values.length > 0) {
        const headers = values[0];
        const idColIdx = findColumnIndex(headers, ['เลขประจำตัว', 'รหัสนักศึกษา', 'student id', 'id']);
        if (idColIdx !== -1) {
          return s;
        }
      }
    }
  }
  
  // 3. Auto-create 'รายชื่อนักศึกษา' sheet with template headers if missing
  sheet = ss.insertSheet(CONFIG.STUDENT_SHEET_NAME);
  sheet.appendRow(['รหัสนักศึกษา', 'ชื่อ-นามสกุล', 'LINE ID']);
  
  // Format Header
  const headerRange = sheet.getRange(1, 1, 1, 3);
  headerRange.setBackground('#06C755');
  headerRange.setFontColor('#ffffff');
  headerRange.setFontWeight('bold');

  // Insert sample student rows as template
  sheet.appendRow(['65010001', 'นายสมชาย สายสแกน', '']);
  sheet.appendRow(['65010002', 'นางสาวสมหญิง ลาดกระบัง', '']);
  sheet.appendRow(['65010003', 'นายณัฐพงษ์ เรียนดี', '']);

  return sheet;
}

/**
 * Save Base64 Image to Google Drive Subfolder (Grouped by Student ID)
 */
function saveSlipToDrive(studentIdOrEmail, feeName, base64Data) {
  try {
    const parentFolder = DriveApp.getFolderById(CONFIG.FOLDER_ID);
    
    // Clean folder name (e.g. Student ID: 69010012)
    let folderName = studentIdOrEmail ? studentIdOrEmail.toString().trim() : 'ไม่ระบุรหัส';
    folderName = folderName.replace(/[^a-zA-Z0-9\u0E00-\u0E7F_-]/g, '_');

    // Find or create subfolder for this student ID
    const existingFolders = parentFolder.getFoldersByName(folderName);
    let targetFolder;
    if (existingFolders.hasNext()) {
      targetFolder = existingFolders.next();
    } else {
      targetFolder = parentFolder.createFolder(folderName);
      targetFolder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    let contentType = 'image/png';
    let rawBase64 = base64Data;
    
    if (base64Data.indexOf(',') !== -1) {
      const parts = base64Data.split(',');
      const match = parts[0].match(/:(.*?);/);
      if (match && match[1]) {
        contentType = match[1];
      }
      rawBase64 = parts[1];
    }
    
    const decodedBytes = Utilities.base64Decode(rawBase64);
    const cleanFee = feeName.replace(/[^a-zA-Z0-9\u0E00-\u0E7F]/g, '_').substring(0, 15);
    const fileName = `SLIP_${folderName}_${cleanFee}_${Date.now()}.png`;
    
    const blob = Utilities.newBlob(decodedBytes, contentType, fileName);
    const file = targetFolder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    
    return file.getUrl();
  } catch (e) {
    Logger.log('Drive Save Error: ' + e.toString());
    return 'https://drive.google.com/drive/folders/' + CONFIG.FOLDER_ID;
  }
}

/**
 * Get or Initialize Payments Sheet
 */
function getOrCreatePaymentsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName(CONFIG.PAYMENTS_SHEET_NAME);
  
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.PAYMENTS_SHEET_NAME);
    sheet.appendRow([
      'วันเวลาที่ส่ง',
      'ชื่อ-นามสกุล',
      'ข้อมูลประจำตัว/รหัส',
      'รายการชำระเงิน',
      'จำนวนเงิน (บาท)',
      'สถานะ',
      'ลิงก์สลิปใน Google Drive',
      'ข้อมูล QR Ref บนสลิป',
      'หมายเหตุ'
    ]);

    const headerRange = sheet.getRange(1, 1, 1, 9);
    headerRange.setBackground('#ff6b00');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
  }
  
  return sheet;
}

function createJsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function updatePaymentStatusInSheet(studentId, feeName, status) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.PAYMENTS_SHEET_NAME);
  if (!sheet) return { status: 'error', message: 'ไม่พบชีตรายการชำระเงิน' };
  
  const data = sheet.getDataRange().getValues();
  
  const cleanSearchId = studentId ? studentId.toString().split('.')[0].replace(/[^0-9a-zA-Z]/g, '').trim().toLowerCase() : '';
  const cleanSearchFee = feeName ? feeName.toString().replace(/\s+/g, '').trim().toLowerCase() : '';

  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][2] ? data[i][2].toString().trim() : '';
    const rowFee = data[i][3] ? data[i][3].toString().trim() : '';
    
    const cleanRowId = rowId.split('.')[0].replace(/[^0-9a-zA-Z]/g, '').trim().toLowerCase();
    const cleanRowFee = rowFee.replace(/\s+/g, '').trim().toLowerCase();
    
    if ((!cleanSearchId || cleanRowId === cleanSearchId) && (!cleanSearchFee || cleanRowFee === cleanSearchFee)) {
      sheet.getRange(i + 1, 6).setValue(status);
      SpreadsheetApp.flush();
      return { status: 'success', message: 'อัปเดตสถานะเป็น ' + status + ' เรียบร้อยแล้ว' };
    }
  }
  return { status: 'error', message: 'ไม่พบแถวรายการชำระเงินที่ระบุ' };
}

/**
 * Get or Initialize Fee Items Sheet (รายการเก็บเงิน)
 */
function getOrCreateFeeItemsSheet() {
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName('รายการเก็บเงิน');
  if (!sheet) {
    sheet = ss.insertSheet('รายการเก็บเงิน');
    sheet.appendRow(['ID', 'หมวดหมู่', 'ชื่อรายการ', 'รายละเอียด', 'จำนวนเงิน', 'วันครบกำหนด']);
    const headerRange = sheet.getRange(1, 1, 1, 6);
    headerRange.setBackground('#ff6b00');
    headerRange.setFontColor('#ffffff');
    headerRange.setFontWeight('bold');
  }
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const items = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] || data[i][2]) {
      items.push({
        id: data[i][0] ? data[i][0].toString() : ('fee-' + i),
        category: data[i][1] ? data[i][1].toString() : 'ค่าห้อง',
        name: data[i][2] ? data[i][2].toString() : '',
        description: data[i][3] ? data[i][3].toString() : '',
        amount: parseFloat(data[i][4]) || 0,
        dueDate: data[i][5] ? data[i][5].toString() : ''
      });
    }
  }
  return items;
}

function saveFeeItemToSheet(item) {
  if (!item) return { status: 'error', message: 'ไม่พบข้อมูล feeItem' };
  const ss = getSpreadsheet();
  let sheet = ss.getSheetByName('รายการเก็บเงิน');
  if (!sheet) {
    getOrCreateFeeItemsSheet();
    sheet = ss.getSheetByName('รายการเก็บเงิน');
  }
  
  sheet.appendRow([
    item.id || ('fee-' + Date.now()),
    item.category || 'ค่าห้อง',
    item.name || '',
    item.description || '',
    item.amount || 0,
    item.dueDate || ''
  ]);
  SpreadsheetApp.flush();
  return { status: 'success', message: 'บันทึกรายการเก็บเงินเรียบร้อยแล้ว' };
}

function deleteFeeItemFromSheet(feeId, feeName) {
  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName('รายการเก็บเงิน');
  if (!sheet) return { status: 'error', message: 'ไม่พบชีตรายการเก็บเงิน' };
  
  const data = sheet.getDataRange().getValues();
  const cleanTargetId = feeId ? feeId.toString().trim().toLowerCase() : '';
  const cleanTargetName = feeName ? feeName.toString().trim().toLowerCase() : '';

  for (let i = 1; i < data.length; i++) {
    const rowId = data[i][0] ? data[i][0].toString().trim().toLowerCase() : '';
    const rowName = data[i][2] ? data[i][2].toString().trim().toLowerCase() : '';

    if ((cleanTargetId && rowId === cleanTargetId) || (cleanTargetName && rowName === cleanTargetName)) {
      sheet.deleteRow(i + 1);
      SpreadsheetApp.flush();
      return { status: 'success', message: 'ลบรายการเก็บเงินเรียบร้อยแล้ว' };
    }
  }
  return { status: 'error', message: 'ไม่พบรายการเก็บเงินที่ต้องการลบ' };
}

function getAdminLineUserId() {
  const ss = getSpreadsheet();
  const sheet = getStudentSheet(ss);
  if (!sheet) return null;

  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idColIdx = findColumnIndex(headers, ['เลขประจำตัว', 'รหัสนักศึกษา', 'student id', 'id']);
  const lineColIdx = findColumnIndex(headers, ['line id', 'line_id', 'line', 'ไลน์', 'ติดต่อ']);

  if (idColIdx === -1 || lineColIdx === -1) return null;

  for (let i = 1; i < data.length; i++) {
    if (!data[i][idColIdx]) continue;
    const cleanRowId = data[i][idColIdx].toString().split('.')[0].replace(/[^0-9a-zA-Z]/g, '').trim();
    if (cleanRowId === '69010115') {
      return data[i][lineColIdx] ? data[i][lineColIdx].toString().trim() : null;
    }
  }
  return null;
}

function sendLinePushMessage(userId, message) {
  const token = CONFIG.LINE_BOT_ACCESS_TOKEN;
  if (!token || !userId) return;

  const url = "https://api.line.me/v2/bot/message/push";
  const payload = {
    to: userId,
    messages: [
      {
        type: "text",
        text: message
      }
    ]
  };

  const options = {
    method: "post",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    Logger.log("LINE Bot push status: " + response.getResponseCode() + " - " + response.getContentText());
  } catch (e) {
    Logger.log("LINE Bot push failed: " + e.toString());
  }
}

function testAdminNotification() {
  const adminLineId = getAdminLineUserId();
  Logger.log("Admin LINE User ID in Sheet: " + adminLineId);
  if (!adminLineId) {
    Logger.log("ไม่พบ LINE ID ของแอดมินรหัส 69010115 ในชีต 'รายชื่อนักศึกษา' กรุณาล็อกอินผ่านเว็บก่อน");
    return;
  }
  sendLinePushMessage(adminLineId, "ทดสอบส่งแจ้งเตือนจากระบบ KMITL Pay! 🟢");
}
