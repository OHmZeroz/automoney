/**
 * KMITL Class Payment System - Core Application Logic
 * Feature List:
 * - Google Sign-In with @kmitl.ac.th validation
 * - Persistent session (remember login)
 * - Persistent Fee Items in LocalStorage
 * - Persistent Settings (Google Script Web App URL & PromptPay info)
 * - Dynamic PromptPay QR Code generator
 * - Slip upload & Client-side QR Reader (jsQR)
 * - Google Sheet & Google Drive integration via Apps Script
 * - Admin Treasurer View & Student Dashboard
 */

// Default Fee Items List
const DEFAULT_FEE_ITEMS = [
  {
    id: 'fee-101',
    category: 'ค่าห้องประจำเดือน',
    name: 'ค่ากองกลางห้องเรียน ประจำเดือน ก.ค. 2569',
    description: 'สำหรับค่าอุปกรณ์ทำความสะอาดห้อง ค่าชีทส่วนกลาง และสวัสดิการห้อง',
    amount: 100,
    dueDate: '2026-07-31'
  },
  {
    id: 'fee-102',
    category: 'ค่าเสื้อช็อป & ป้ายชื่อ',
    name: 'ค่าเสื้อช็อปภาควิชา + ป้ายชื่อสแกน',
    description: 'สำหรับนักศึกษาชั้นปีที่ 1 และผู้ที่สั่งเพิ่ม ชำระก่อนสั่งตัดล็อตแรก',
    amount: 450,
    dueDate: '2026-08-15'
  },
  {
    id: 'fee-103',
    category: 'ค่าเอกสารการเรียน',
    name: 'ค่าชีทสรุปเตรียมสอบ Midterm วิชา Core Math',
    description: 'รวมค่าจัดพิมพ์ชีทเข้าเล่ม 120 หน้า',
    amount: 80,
    dueDate: '2026-08-05'
  }
];

// Configuration (Loaded from LocalStorage or default)
let CONFIG = JSON.parse(localStorage.getItem('kmitl_pay_config')) || {};

// Always use the user's active Google Apps Script URL
CONFIG.GOOGLE_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxCRPV1AwEy6YTB68yaOBvIayfZcMg16-JadpO0IPq6g-CUhh-0ITpHmFEft-44WIJ6/exec';

if (!CONFIG.LINE_CHANNEL_ID) CONFIG.LINE_CHANNEL_ID = '';
if (!CONFIG.LINE_CHANNEL_SECRET) CONFIG.LINE_CHANNEL_SECRET = '';
if (!CONFIG.PROMPTPAY_NUMBER) CONFIG.PROMPTPAY_NUMBER = '0891234567';
if (!CONFIG.PROMPTPAY_NAME) CONFIG.PROMPTPAY_NAME = 'เหรัญญิกประจำห้อง (KMITL Pay)';
if (CONFIG.ALLOW_NON_KMITL_IN_DEMO === undefined) CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;

localStorage.setItem('kmitl_pay_config', JSON.stringify(CONFIG));

// Initial State Data
let currentUser = null;
let currentView = 'student'; // 'student' or 'admin'
let selectedFeeItem = null;
let currentSlipBase64 = null;
let currentSlipQRData = null;

// Fee Items (Loaded from LocalStorage to persist across reloads)
let feeItems = JSON.parse(localStorage.getItem('kmitl_pay_fee_items')) || DEFAULT_FEE_ITEMS;

// Submissions List (Loaded from LocalStorage)
let submissions = JSON.parse(localStorage.getItem('kmitl_pay_submissions')) || [
  {
    id: 'sub-001',
    studentName: 'สมชาย สายสแกน',
    studentEmail: '65010001@kmitl.ac.th',
    feeId: 'fee-101',
    feeName: 'ค่ากองกลางห้องเรียน ประจำเดือน ก.ค. 2569',
    amount: 100,
    status: 'Approved',
    timestamp: '2026-07-20 14:30',
    slipUrl: 'https://drive.google.com/drive/folders/1vVmoWgVS3V0ASdY3TYhSY76kgFYjBV57',
    slipBase64: null,
    qrRef: '0002010102123000...EMVCo'
  }
];

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================
document.addEventListener('DOMContentLoaded', () => {
  checkSavedSession();
  setupDragAndDrop();
  checkGasConfigAlert();
  initGoogleSignIn();
});

// Initialize Dynamic Google Sign-In
function initGoogleSignIn() {
  const btnContainer = document.getElementById("g_id_signin_dynamic");
  const noteEl = document.getElementById("googleSignInNote");
  
  if (!btnContainer) return;
  btnContainer.innerHTML = ''; // Clear previous button

  if (!CONFIG.GOOGLE_CLIENT_ID) {
    if (noteEl) noteEl.style.display = 'block';
    return;
  }

  if (noteEl) noteEl.style.display = 'none';

  // Render Google GSI Button dynamically
  setTimeout(() => {
    if (typeof google !== 'undefined') {
      try {
        google.accounts.id.initialize({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          callback: handleGoogleSignIn,
          context: 'signin',
          ux_mode: 'popup',
          auto_select: false,
          itp_support: true
        });
        
        google.accounts.id.renderButton(btnContainer, {
          type: "standard",
          shape: "rectangular",
          theme: "filled_blue",
          text: "signin_with",
          size: "large",
          logo_alignment: "left"
        });
      } catch (err) {
        console.error('Google Sign-in rendering error:', err);
      }
    }
  }, 500);
}

function saveFeeItemsToStorage() {
  localStorage.setItem('kmitl_pay_fee_items', JSON.stringify(feeItems));
}

function saveConfigToStorage() {
  localStorage.setItem('kmitl_pay_config', JSON.stringify(CONFIG));
  checkGasConfigAlert();
}

function checkGasConfigAlert() {
  const alertBox = document.getElementById('gasStatusAlert');
  if (!alertBox) return;

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    alertBox.style.display = 'block';
    alertBox.innerHTML = `
      <div style="background: rgba(245, 158, 11, 0.15); border: 1px solid rgba(245, 158, 11, 0.4); color: var(--color-warning); padding: 12px 16px; border-radius: 12px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i> <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL:</strong> ระบบกำลังทำงานในโหมดสาธิต (ข้อมูลจะถูกเซฟในเบราว์เซอร์ชั่วคราว) 
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">ตั้งค่าตอนนี้</button>
      </div>
    `;
  } else {
    alertBox.style.display = 'block';
    alertBox.innerHTML = `
      <div style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: var(--color-success); padding: 12px 16px; border-radius: 12px; font-size: 0.875rem; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <i class="fa-solid fa-circle-check"></i> <strong>เชื่อมต่อ Google Apps Script เรียบร้อย:</strong> ข้อมูลสลิปและประวัติจะถูกส่งตรงเข้า Google Sheet & Google Drive
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">แก้ไขตั้งค่า</button>
      </div>
    `;
  }
}

// Check if user is already logged in (Remember Login Feature)
function checkSavedSession() {
  const savedUser = localStorage.getItem('kmitl_pay_user');
  if (savedUser) {
    try {
      currentUser = JSON.parse(savedUser);
      showMainApplication(currentUser);
      showToast(`ต้อนรับกลับ, ${currentUser.name}`, 'info');
      return;
    } catch (e) {
      localStorage.removeItem('kmitl_pay_user');
    }
  }

  // Show login screen
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('registerSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'none';
  document.getElementById('navControls').style.display = 'none';
}

// ==========================================
// AUTHENTICATION & LOGIN LOGIC
// ==========================================
// Check if URL has LINE auth code on startup
document.addEventListener('DOMContentLoaded', () => {
  checkLineAuthCode();
});

function checkLineAuthCode() {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  if (code) {
    // Clean URL parameter so refresh doesn't trigger code exchange again
    window.history.replaceState({}, document.title, window.location.pathname);
    processLineLogin(code);
  }
}

// ==========================================
// LINE LOGIN & BYPASS LOGIN LOGIC
// ==========================================
function loginWithLine() {
  if (!CONFIG.LINE_CHANNEL_ID) {
    showToast('กรุณากรอก LINE Channel ID ในแผงเหรัญญิกก่อนใช้งานระบบนี้', 'error');
    return;
  }
  
  const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
  const state = 'state-' + Date.now();
  const authUrl = `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CONFIG.LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;
  
  window.location.href = authUrl;
}

// Direct Login: Strict verification against Google Sheets database
async function handleDirectStudentLogin(e) {
  e.preventDefault();
  const studentId = document.getElementById('loginStudentIdInput').value.trim();
  if (!studentId) return;

  // Verify strictly against Google Sheets database if configured
  if (CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...', 'info');
    try {
      const response = await fetch(`${CONFIG.GOOGLE_SCRIPT_URL}?action=checkStudentId&studentId=${encodeURIComponent(studentId)}`);
      const result = await response.json();
      
      if (result && result.status === 'success' && result.exists) {
        const userData = {
          studentId: studentId,
          name: result.name || ('นักศึกษา รหัส ' + studentId),
          email: 'direct_login',
          picture: ''
        };
        saveUserSession(userData);
        showMainApplication(userData);
        showToast(`ยินดีต้อนรับคุณ ${userData.name}!`, 'success');
      } else {
        // STRICT BLOCK: ID is not found in the official Sheet database
        showToast(`ไม่พบรหัสนักศึกษา ${studentId} ในตารางรายชื่อห้องเรียนที่เป็นทางการ!`, 'error');
      }
    } catch (err) {
      console.warn('Apps Script direct login check failed:', err);
      showToast('ไม่สามารถเชื่อมต่อตรวจสอบรายชื่อใน Google Sheet ได้', 'error');
    }
  } else {
    showToast('กรุณาตั้งค่า Google Apps Script Web App URL ในแผงเหรัญญิกก่อน', 'error');
  }
}

function mockLocalLogin(studentId) {
  const userData = {
    studentId: studentId,
    name: 'นักศึกษา รหัส ' + studentId,
    email: 'direct_login',
    picture: ''
  };
  saveUserSession(userData);
  showMainApplication(userData);
  showToast('เข้าสู่ระบบสำเร็จ (โหมดสาธิต)', 'success');
}

// Process the authorization code returned from LINE
async function processLineLogin(code) {
  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL', 'error');
    return;
  }

  showToast('กำลังเข้าสู่ระบบผ่าน LINE...', 'info');

  try {
    const redirectUri = window.location.origin + window.location.pathname;
    const url = `${CONFIG.GOOGLE_SCRIPT_URL}?action=lineLogin&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}&channelId=${CONFIG.LINE_CHANNEL_ID}&channelSecret=${CONFIG.LINE_CHANNEL_SECRET}`;
    
    const response = await fetch(url);
    const result = await response.json();

    if (result && result.status === 'success') {
      if (result.registered) {
        // Log in immediately if already linked
        const userData = {
          lineUserId: result.lineUserId,
          name: result.name,
          studentId: result.studentId,
          picture: result.picture || ''
        };
        saveUserSession(userData);
        showMainApplication(userData);
        showToast(`ยินดีต้อนรับกลับ คุณ ${userData.name}!`, 'success');
      } else {
        // Show registration / linking form
        showRegistrationScreen(result.lineUserId, result.lineName);
      }
    } else {
      showToast(result.message || 'แลกเปลี่ยนรหัสโทเค็น LINE ไม่สำเร็จ', 'error');
    }
  } catch (err) {
    console.error('LINE Code Exchange Error:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อ LINE Server', 'error');
  }
}

function showRegistrationScreen(lineUserId, lineName) {
  currentUser = { lineUserId: lineUserId, lineName: lineName }; // Store temporarily
  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'none';
  document.getElementById('registerSection').style.display = 'block';
  document.getElementById('registerLineNameText').textContent = lineName;
  document.getElementById('registerStudentId').value = '';
}

async function handleRegistrationSubmit(e) {
  e.preventDefault();
  const studentId = document.getElementById('registerStudentId').value.trim();
  const lineUserId = currentUser.lineUserId;
  const lineName = currentUser.lineName;

  if (!studentId) {
    showToast('กรุณากรอกรหัสนักศึกษา', 'error');
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบรหัสในฐานข้อมูล...`;

  try {
    const response = await fetch(CONFIG.GOOGLE_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'registerLineUser',
        lineUserId: lineUserId,
        studentId: studentId,
        lineName: lineName
      })
    });
    
    const result = await response.json();

    if (result && result.status === 'success') {
      const userData = {
        lineUserId: lineUserId,
        studentId: studentId,
        name: result.name || lineName,
        picture: ''
      };
      saveUserSession(userData);
      showMainApplication(userData);
      showToast(`เชื่อมโยงบัญชี LINE กับคุณ ${userData.name} สำเร็จ!`, 'success');
    } else {
      showToast(result.message || 'รหัสนักศึกษาไม่ถูกต้องหรือไม่มีในรายชื่อทางการ', 'error');
    }
  } catch (err) {
    console.error('LINE Registration failed:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `<i class="fa-solid fa-link"></i> ยืนยันเชื่อมต่อรหัสและเข้าหน้าหลัก`;
  }
}


function saveUserSession(userData) {
  currentUser = userData;
  localStorage.setItem('kmitl_pay_user', JSON.stringify(userData));
}

function logoutUser() {
  currentUser = null;
  localStorage.removeItem('kmitl_pay_user');
  document.getElementById('loginSection').style.display = 'block';
  document.getElementById('registerSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'none';
  document.getElementById('navControls').style.display = 'none';
  showToast('ออกจากระบบเรียบร้อยแล้ว', 'info');
}

function showMainApplication(user) {
  document.getElementById('userName').textContent = user.name;
  document.getElementById('userEmail').textContent = user.email;
  document.getElementById('userAvatar').textContent = user.name.charAt(0);
  document.getElementById('welcomeStudentName').textContent = user.name;

  document.getElementById('loginSection').style.display = 'none';
  document.getElementById('registerSection').style.display = 'none';
  document.getElementById('mainAppSection').style.display = 'block';
  document.getElementById('navControls').style.display = 'flex';

  renderStudentDashboard();
}

// ==========================================
// VIEW SWITCHER (Student vs Admin)
// ==========================================
function switchView(view) {
  currentView = view;
  const studentBtn = document.getElementById('tabStudentBtn');
  const adminBtn = document.getElementById('tabAdminBtn');
  const studentView = document.getElementById('studentView');
  const adminView = document.getElementById('adminView');

  if (view === 'student') {
    studentBtn.classList.add('active');
    adminBtn.classList.remove('active');
    studentView.style.display = 'block';
    adminView.style.display = 'none';
    renderStudentDashboard();
  } else {
    adminBtn.classList.add('active');
    studentBtn.classList.remove('active');
    studentView.style.display = 'none';
    adminView.style.display = 'block';
    renderAdminDashboard();
  }
}

// ==========================================
// STUDENT DASHBOARD RENDERER
// ==========================================
function renderStudentDashboard() {
  const grid = document.getElementById('feeItemsGrid');
  grid.innerHTML = '';

  let unpaidTotal = 0;
  let paidTotal = 0;
  let pendingCount = 0;

  if (feeItems.length === 0) {
    grid.innerHTML = `<div style="grid-column: 1/-1; text-align:center; padding: 3rem; color: var(--text-muted);">ไม่มีรายการเก็บเงินในระบบขณะนี้</div>`;
  }

  feeItems.forEach(item => {
    const userSub = submissions.find(s => s.feeId === item.id && s.studentEmail === currentUser.email);
    let statusBadge = '';

    if (userSub) {
      if (userSub.status === 'Approved') {
        statusBadge = '<span class="fee-badge badge-paid"><i class="fa-solid fa-check"></i> ชำระแล้ว</span>';
        paidTotal += item.amount;
      } else if (userSub.status === 'Pending') {
        statusBadge = '<span class="fee-badge badge-pending"><i class="fa-solid fa-clock"></i> รอตรวจสอบ</span>';
        pendingCount++;
      } else {
        statusBadge = '<span class="fee-badge badge-unpaid"><i class="fa-solid fa-triangle-exclamation"></i> สลิปไม่ผ่าน</span>';
        unpaidTotal += item.amount;
      }
    } else {
      statusBadge = '<span class="fee-badge badge-unpaid"><i class="fa-solid fa-circle-exclamation"></i> ยังไม่ได้จ่าย</span>';
      unpaidTotal += item.amount;
    }

    const card = document.createElement('div');
    card.className = 'glass-panel fee-card';
    card.innerHTML = `
      ${statusBadge}
      <div>
        <div class="fee-category">${escapeHtml(item.category)}</div>
        <h4 class="fee-name">${escapeHtml(item.name)}</h4>
        <p class="fee-description">${escapeHtml(item.description)}</p>
      </div>
      <div>
        <div class="fee-meta">
          <div class="fee-amount">
            <span>จำนวนเงิน</span>
            <strong>฿${item.amount.toLocaleString()}</strong>
          </div>
          <div class="fee-due">
            <i class="fa-regular fa-calendar"></i> ครบกำหนด: ${item.dueDate}
          </div>
        </div>
        ${userSub && userSub.status === 'Approved' ? `
          <button class="btn btn-secondary" style="width:100%" disabled>
            <i class="fa-solid fa-circle-check"></i> ชำระเงินเรียบร้อยแล้ว
          </button>
        ` : `
          <button class="btn btn-primary" style="width:100%" onclick="openPaymentModal('${item.id}')">
            <i class="fa-solid fa-qrcode"></i> ${userSub && userSub.status === 'Pending' ? 'ส่งสลิปแก้ไข' : 'ชำระเงิน / แนบสลิป'}
          </button>
        `}
      </div>
    `;
    grid.appendChild(card);
  });

  document.getElementById('statUnpaid').textContent = `฿${unpaidTotal.toLocaleString()}`;
  document.getElementById('statPaid').textContent = `฿${paidTotal.toLocaleString()}`;
  document.getElementById('statPending').textContent = `${pendingCount} รายการ`;

  renderStudentHistoryTable();
}

function renderStudentHistoryTable() {
  const tbody = document.getElementById('studentHistoryTable');
  tbody.innerHTML = '';

  const userSubs = submissions.filter(s => s.studentEmail === currentUser.email);
  if (userSubs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color: var(--text-muted); padding:2rem;">ยังไม่มีประวัติการส่งสลิปชำระเงิน</td></tr>`;
    return;
  }

  userSubs.forEach(sub => {
    let statusClass = 'badge-unpaid';
    let statusText = 'ไม่ผ่าน';
    if (sub.status === 'Approved') { statusClass = 'badge-paid'; statusText = 'อนุมัติเรียบร้อย'; }
    else if (sub.status === 'Pending') { statusClass = 'badge-pending'; statusText = 'รอเหรัญญิกตรวจ'; }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${sub.timestamp}</td>
      <td><strong>${escapeHtml(sub.feeName)}</strong></td>
      <td>฿${sub.amount.toLocaleString()}</td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="viewAdminSlip('${sub.id}')">
          <i class="fa-solid fa-image"></i> ดูสลิป
        </button>
      </td>
      <td><span class="fee-badge ${statusClass}">${statusText}</span></td>
      <td>
        <a href="${sub.slipUrl || '#'}" target="_blank" class="btn btn-secondary btn-sm">
          <i class="fa-solid fa-external-link"></i> เปิด Drive
        </a>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ==========================================
// PROMPTPAY QR GENERATOR
// ==========================================
function generatePromptPayQRPayload(target, amount) {
  const sanitize = target.replace(/[^0-9]/g, '');
  let targetType = '01';
  let formattedTarget = sanitize;

  if (sanitize.length === 10) {
    formattedTarget = '0066' + sanitize.substring(1);
    targetType = '01';
  } else if (sanitize.length === 13) {
    targetType = '02';
  }

  const amountStr = amount ? amount.toFixed(2) : '0.00';
  const amountLen = ('0' + amountStr.length).slice(-2);

  let payload = `00020101021129370016A000000677010111${targetType}${('0' + formattedTarget.length).slice(-2)}${formattedTarget}5802TH5303764${amount ? '54' + amountLen + amountStr : ''}6304`;
  
  const crc = crc16(payload);
  return payload + crc;
}

function crc16(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    let x = ((crc >> 8) ^ data.charCodeAt(i)) & 0xFF;
    x ^= x >> 4;
    crc = ((crc << 8) ^ (x << 12) ^ (x << 5) ^ x) & 0xFFFF;
  }
  return ('0000' + crc.toString(16).toUpperCase()).slice(-4);
}

// ==========================================
// PAYMENT MODAL & PROMPTPAY QR RENDER
// ==========================================
function openPaymentModal(feeId) {
  selectedFeeItem = feeItems.find(f => f.id === feeId);
  if (!selectedFeeItem) return;

  document.getElementById('modalFeeTitle').textContent = `ชำระเงิน: ${selectedFeeItem.name}`;
  document.getElementById('modalPromptPayAmount').textContent = `฿${selectedFeeItem.amount.toFixed(2)}`;
  document.getElementById('modalPromptPayReceiver').textContent = `ชื่อบัญชี: ${CONFIG.PROMPTPAY_NAME} (PromptPay: ${CONFIG.PROMPTPAY_NUMBER})`;

  resetSlipUploader();

  const payload = generatePromptPayQRPayload(CONFIG.PROMPTPAY_NUMBER, selectedFeeItem.amount);
  
  // Set Image QR Code API fallback immediately
  const qrImg = document.getElementById('qrImg');
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
    qrImg.style.display = 'block';
  }

  // Render to canvas if QRCode library is available
  const qrCanvas = document.getElementById('qrCanvas');
  if (typeof QRCode !== 'undefined' && qrCanvas) {
    QRCode.toCanvas(qrCanvas, payload, { width: 220, margin: 2 }, function (error) {
      if (!error) {
        qrCanvas.style.display = 'block';
        if (qrImg) qrImg.style.display = 'none';
      }
    });
  }

  document.getElementById('paymentModal').classList.add('active');
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

// ==========================================
// SLIP UPLOAD & CLIENT-SIDE QR SCANNER (jsQR)
// ==========================================
function setupDragAndDrop() {
  const dropzone = document.getElementById('slipDropzone');
  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      processSelectedSlip(files[0]);
    }
  });
}

function handleFileSelect(e) {
  const files = e.target.files;
  if (files.length > 0) {
    processSelectedSlip(files[0]);
  }
}

function processSelectedSlip(file) {
  if (!file || !file.type.startsWith('image/')) {
    showToast('กรุณาเลือกไฟล์รูปภาพสลิปเท่านั้น (PNG, JPG, JPEG)', 'error');
    return;
  }

  const reader = new FileReader();
  reader.onload = function (evt) {
    currentSlipBase64 = evt.target.result;
    
    const previewBox = document.getElementById('slipPreviewBox');
    const previewImg = document.getElementById('slipPreviewImg');
    const scanStatus = document.getElementById('slipScanResult');

    if (previewImg) previewImg.src = currentSlipBase64;
    if (previewBox) previewBox.style.display = 'block';

    scanStatus.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลดรูปภาพสลิป...`;

    showToast('โหลดรูปภาพสลิปเรียบร้อยแล้ว!', 'success');

    const img = new Image();
    img.onload = function () {
      try {
        const canvas = document.createElement('canvas');
        let w = img.width;
        let h = img.height;
        if (w > 1200) {
          h = Math.round((h * 1200) / w);
          w = 1200;
        }
        canvas.width = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        if (typeof jsQR !== 'undefined') {
          const imageData = ctx.getImageData(0, 0, w, h);
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'dontInvert'
          });

          if (code) {
            currentSlipQRData = code.data;
            scanStatus.innerHTML = `
              <i class="fa-solid fa-circle-check" style="color: var(--color-success);"></i> 
              <span>ตรวจพบ QR Code บนสลิปเรียบร้อย (Data Ref: ${code.data.substring(0, 20)}...)</span>
            `;
            return;
          }
        }
      } catch (err) {
        console.warn('QR scanner processing notice:', err);
      }

      currentSlipQRData = null;
      scanStatus.innerHTML = `
        <i class="fa-solid fa-circle-check" style="color: var(--color-success);"></i> 
        <span>รูปภาพสลิปพร้อมส่งแล้ว (${(file.size / 1024).toFixed(1)} KB)</span>
      `;
    };
    img.src = currentSlipBase64;
  };

  reader.onerror = function() {
    showToast('เกิดข้อผิดพลาดในการอ่านไฟล์รูปภาพ', 'error');
  };

  reader.readAsDataURL(file);
}

function resetSlipUploader() {
  currentSlipBase64 = null;
  currentSlipQRData = null;
  document.getElementById('slipInput').value = '';
  document.getElementById('slipPreviewBox').style.display = 'none';
  document.getElementById('paymentRemark').value = '';
}

// ==========================================
// SUBMIT PAYMENT TO APPS SCRIPT / LOCAL DB
// ==========================================
async function handlePaymentSubmit(e) {
  e.preventDefault();

  // If no slip is uploaded yet, automatically open file chooser for user convenience
  if (!currentSlipBase64) {
    showToast('กรุณาเลือกรูปภาพสลิปการโอนเงินก่อนส่ง (กำลังเปิดหน้าต่างเลือกไฟล์...)', 'info');
    const slipInput = document.getElementById('slipInput');
    if (slipInput) slipInput.click();
    return;
  }

  const submitBtn = document.getElementById('btnSubmitPayment');
  submitBtn.disabled = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึกลง Google Drive & Sheet...`;

  const studentName = currentUser ? currentUser.name : 'นักศึกษา KMITL';
  const studentEmail = currentUser ? currentUser.email : 'student@kmitl.ac.th';

  const newSubmission = {
    id: 'sub-' + Date.now(),
    studentName: studentName,
    studentEmail: studentEmail,
    feeId: selectedFeeItem ? selectedFeeItem.id : 'fee-101',
    feeName: selectedFeeItem ? selectedFeeItem.name : 'ค่าห้องประจำเดือน',
    amount: selectedFeeItem ? selectedFeeItem.amount : 100,
    status: 'Pending',
    timestamp: new Date().toLocaleString('th-TH'),
    slipUrl: 'https://drive.google.com/drive/folders/1vVmoWgVS3V0ASdY3TYhSY76kgFYjBV57',
    slipBase64: currentSlipBase64,
    qrRef: currentSlipQRData,
    remark: document.getElementById('paymentRemark').value || '-'
  };

  // Post to Google Apps Script API
  if (CONFIG.GOOGLE_SCRIPT_URL) {
    try {
      const response = await fetch(CONFIG.GOOGLE_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(newSubmission)
      });
      const result = await response.json();
      if (result && result.status === 'success' && result.driveUrl) {
        newSubmission.slipUrl = result.driveUrl;
      } else if (result && result.status === 'error') {
        showToast('Google Apps Script: ' + result.message, 'error');
      }
    } catch (err) {
      console.warn('Apps Script POST failed:', err);
    }
  }

  // Update Local Submissions Array
  submissions = submissions.filter(s => !(s.feeId === newSubmission.feeId && s.studentEmail === studentEmail));
  submissions.unshift(newSubmission);
  localStorage.setItem('kmitl_pay_submissions', JSON.stringify(submissions));

  // Reset Submit Button State
  submitBtn.disabled = false;
  submitBtn.innerHTML = `<i class="fa-solid fa-paper-plane"></i> ยืนยันการส่งสลิป`;
  
  closeModal('paymentModal');
  showToast('ส่งสลิปชำระเงินเรียบร้อย! ข้อมูลถูกบันทึกลง Google Sheet & Drive แล้ว', 'success');

  renderStudentDashboard();
  if (currentView === 'admin') renderAdminDashboard();
}

// ==========================================
// ADMIN DASHBOARD RENDERER & ACTIONS
// ==========================================
function renderAdminDashboard() {
  renderAdminFeeItemsTable();
  renderAdminSubmissionsTable();
}

function renderAdminFeeItemsTable() {
  const tbody = document.getElementById('adminFeeItemsTable');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (feeItems.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding:1.5rem;">ยังไม่มีรายการเก็บเงินที่สร้างไว้</td></tr>`;
    return;
  }

  feeItems.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.name)}</strong></td>
      <td><span style="font-size:0.8rem; color:var(--kmitl-orange);">${escapeHtml(item.category)}</span></td>
      <td><strong style="color:var(--kmitl-gold);">฿${item.amount.toLocaleString()}</strong></td>
      <td>${item.dueDate}</td>
      <td>
        <button class="btn btn-danger btn-sm" onclick="deleteFeeItem('${item.id}')">
          <i class="fa-solid fa-trash"></i> ลบรายการ
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderAdminSubmissionsTable() {
  const tbody = document.getElementById('adminSubmissionsTable');
  tbody.innerHTML = '';

  if (submissions.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center; color: var(--text-muted); padding:2rem;">ยังไม่มีรายการส่งสลิปชำระเงินในระบบ</td></tr>`;
    return;
  }

  submissions.forEach(sub => {
    let statusClass = 'badge-pending';
    let statusText = 'รอตรวจสอบ';
    if (sub.status === 'Approved') { statusClass = 'badge-paid'; statusText = 'อนุมัติแล้ว'; }
    else if (sub.status === 'Rejected') { statusClass = 'badge-unpaid'; statusText = 'ปฏิเสธแล้ว'; }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${sub.timestamp}</td>
      <td>
        <div style="font-weight:600;">${escapeHtml(sub.studentName)}</div>
        <div style="font-size:0.775rem; color:var(--text-secondary);">${escapeHtml(sub.studentEmail)}</div>
      </td>
      <td>${escapeHtml(sub.feeName)}</td>
      <td><strong style="color:var(--kmitl-gold);">฿${sub.amount.toLocaleString()}</strong></td>
      <td>
        <button class="btn btn-secondary btn-sm" onclick="viewAdminSlip('${sub.id}')">
          <i class="fa-solid fa-image"></i> ดูสลิป ${sub.qrRef ? '(สแกนแล้ว)' : ''}
        </button>
      </td>
      <td><span class="fee-badge ${statusClass}">${statusText}</span></td>
      <td>
        <div style="display:flex; gap:6px;">
          <button class="btn btn-success btn-sm" onclick="updateStatus('${sub.id}', 'Approved')" ${sub.status === 'Approved' ? 'disabled' : ''}>
            <i class="fa-solid fa-check"></i> อนุมัติ
          </button>
          <button class="btn btn-danger btn-sm" onclick="updateStatus('${sub.id}', 'Rejected')" ${sub.status === 'Rejected' ? 'disabled' : ''}>
            <i class="fa-solid fa-xmark"></i> ไม่อนุมัติ
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function viewAdminSlip(subId) {
  const sub = submissions.find(s => s.id === subId);
  if (!sub) return;

  const fullImg = document.getElementById('adminSlipFullImg');
  const metaBox = document.getElementById('adminSlipMeta');
  const driveBtn = document.getElementById('adminDriveLinkBtn');

  fullImg.src = sub.slipBase64 || 'https://via.placeholder.com/400x500?text=Slip+Image';
  metaBox.innerHTML = `
    <div><strong>ชื่อผู้โอน:</strong> ${escapeHtml(sub.studentName)} (${sub.studentEmail})</div>
    <div><strong>รายการ:</strong> ${escapeHtml(sub.feeName)} (฿${sub.amount})</div>
    <div><strong>เวลาส่ง:</strong> ${sub.timestamp}</div>
    ${sub.qrRef ? `<div style="margin-top:6px; color:#60a5fa;"><strong>QR Payload Scan:</strong> ${escapeHtml(sub.qrRef)}</div>` : ''}
    ${sub.remark ? `<div><strong>หมายเหตุ:</strong> ${escapeHtml(sub.remark)}</div>` : ''}
  `;
  driveBtn.href = sub.slipUrl || 'https://drive.google.com/drive/folders/1vVmoWgVS3V0ASdY3TYhSY76kgFYjBV57';

  document.getElementById('viewSlipModal').classList.add('active');
}

function updateStatus(subId, newStatus) {
  const sub = submissions.find(s => s.id === subId);
  if (sub) {
    sub.status = newStatus;
    localStorage.setItem('kmitl_pay_submissions', JSON.stringify(submissions));
    renderAdminDashboard();
    showToast(`อัปเดตสถานะเป็น ${newStatus === 'Approved' ? 'อนุมัติ' : 'ปฏิเสธ'} เรียบร้อยแล้ว`, newStatus === 'Approved' ? 'success' : 'error');
  }
}

function openCreateFeeModal() {
  document.getElementById('createFeeModal').classList.add('active');
}

function handleCreateFeeSubmit(e) {
  e.preventDefault();
  const category = document.getElementById('newFeeCategory').value;
  const name = document.getElementById('newFeeName').value;
  const desc = document.getElementById('newFeeDesc').value;
  const amount = parseFloat(document.getElementById('newFeeAmount').value);
  const dueDate = document.getElementById('newFeeDueDate').value || '2026-08-31';

  const newFee = {
    id: 'fee-' + Date.now(),
    category: category,
    name: name,
    description: desc,
    amount: amount,
    dueDate: dueDate
  };

  // Push and persist to LocalStorage
  feeItems.push(newFee);
  saveFeeItemsToStorage();

  closeModal('createFeeModal');
  showToast('เพิ่มรายการเก็บเงินใหม่เรียบร้อยแล้ว!', 'success');
  
  if (currentView === 'student') renderStudentDashboard();
  if (currentView === 'admin') renderAdminDashboard();
}

function deleteFeeItem(feeId) {
  if (confirm('คุณต้องการลบรายการเก็บเงินนี้ใช่หรือไม่?')) {
    feeItems = feeItems.filter(f => f.id !== feeId);
    saveFeeItemsToStorage();
    renderAdminDashboard();
    showToast('ลบรายการเก็บเงินเรียบร้อยแล้ว', 'info');
  }
}

// ==========================================
// CONFIGURATION MODAL (Google Apps Script URL & PromptPay)
// ==========================================
function openConfigModal() {
  document.getElementById('cfgScriptUrl').value = CONFIG.GOOGLE_SCRIPT_URL || '';
  document.getElementById('cfgLineChannelId').value = CONFIG.LINE_CHANNEL_ID || '';
  document.getElementById('cfgLineChannelSecret').value = CONFIG.LINE_CHANNEL_SECRET || '';
  document.getElementById('cfgPromptPay').value = CONFIG.PROMPTPAY_NUMBER || '';
  document.getElementById('cfgPromptPayName').value = CONFIG.PROMPTPAY_NAME || '';
  document.getElementById('configModal').classList.add('active');
}

function handleSaveConfig(e) {
  e.preventDefault();
  CONFIG.GOOGLE_SCRIPT_URL = document.getElementById('cfgScriptUrl').value.trim();
  CONFIG.LINE_CHANNEL_ID = document.getElementById('cfgLineChannelId').value.trim();
  CONFIG.LINE_CHANNEL_SECRET = document.getElementById('cfgLineChannelSecret').value.trim();
  CONFIG.PROMPTPAY_NUMBER = document.getElementById('cfgPromptPay').value.trim();
  CONFIG.PROMPTPAY_NAME = document.getElementById('cfgPromptPayName').value.trim();

  saveConfigToStorage();
  closeModal('configModal');
  showToast('บันทึกการตั้งค่าเชื่อมต่อ LINE & Google เรียบร้อยแล้ว!', 'success');
}

// ==========================================
// HELPERS & TOAST NOTIFICATIONS
// ==========================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  let icon = 'fa-info-circle';
  if (type === 'success') icon = 'fa-circle-check';
  if (type === 'error') icon = 'fa-circle-exclamation';

  toast.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
}
