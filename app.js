/**
 * KMITL Class Payment System - Core Application Logic
 *
 * FIXED VERSION 2
 *
 * แก้ไขหลัก 3 เรื่อง
 * 1) ไม่ต้อง login ใหม่ทุกรอบ
 *    - bootstrap ทำงานแม้ DOM โหลดเสร็จไปแล้ว
 *    - session valid ถ้ามี studentId หรือ lineUserId
 *    - LIFF ถูกใช้กู้ session เสมอเมื่อ localStorage หาย
 *    - flag manual logout ย้ายไป localStorage
 *
 * 2) รูปสลิปเข้า Google Drive จริง
 *    - ส่ง slipBase64 ผ่าน hidden form POST (ไม่มีลิมิตความยาว)
 *    - GAS อ่านได้ทั้ง e.parameter.payload และ e.postData.contents
 *
 * 3) ประวัติการจ่ายขึ้นครบ
 *    - เลิกบังคับรหัสนักศึกษาเป็นตัวเลข 8 หลัก
 *    - normalize ค่าก่อนเทียบ (ตัดช่องว่าง / quote / zero-width)
 *    - ไม่ยัดรหัสนักศึกษาลงช่องอีเมล
 */

// ==========================================
// DEFAULT FEE ITEMS
// ==========================================

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

// ==========================================
// STORAGE KEYS
// ==========================================

const K_USER        = 'kmitl_pay_user';
const K_CONFIG      = 'kmitl_pay_config';
const K_FEE_ITEMS   = 'kmitl_pay_fee_items';
const K_SUBMISSIONS = 'kmitl_pay_submissions';
const K_LOGOUT      = 'kmitl_pay_manual_logout';

// ==========================================
// SAFE STORAGE WRAPPER
// (LINE in-app browser บางเครื่องบล็อค localStorage)
// ==========================================

const memoryStore = {};

function lsGet(key) {
  try {
    const v = localStorage.getItem(key);
    if (v !== null) return v;
  } catch (e) {
    console.warn('[Storage] read blocked:', key);
  }
  return memoryStore[key] !== undefined ? memoryStore[key] : null;
}

function lsSet(key, value) {
  memoryStore[key] = value;
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('[Storage] write blocked:', key);
  }
}

function lsRemove(key) {
  delete memoryStore[key];
  try {
    localStorage.removeItem(key);
  } catch (e) {}
}

// ==========================================
// CONFIGURATION
// ==========================================

let CONFIG = {};

try {
  CONFIG = JSON.parse(lsGet(K_CONFIG)) || {};
} catch (e) {
  CONFIG = {};
}

if (!CONFIG.GOOGLE_SCRIPT_URL) {
  CONFIG.GOOGLE_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbw_OxjIFz_N6wJzF_fFhoJE6P561_jBoWMs8WDO9q8b1RsnYdaDtormoQnupF1oHQ8J/exec';
}

CONFIG.LINE_CHANNEL_ID     = CONFIG.LINE_CHANNEL_ID || '2010801650';
CONFIG.LINE_CHANNEL_SECRET = CONFIG.LINE_CHANNEL_SECRET || '';
CONFIG.LIFF_ID             = CONFIG.LIFF_ID || '2010801650-te43AoZe';

if (!CONFIG.PROMPTPAY_NUMBER) {
  CONFIG.PROMPTPAY_NUMBER = '0891234567';
}

if (!CONFIG.PROMPTPAY_NAME) {
  CONFIG.PROMPTPAY_NAME = 'เหรัญญิกประจำห้อง (KMITL Pay)';
}

if (CONFIG.ALLOW_NON_KMITL_IN_DEMO === undefined) {
  CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;
}

lsSet(K_CONFIG, JSON.stringify(CONFIG));

// ==========================================
// GLOBAL STATE
// ==========================================

let currentUser        = null;
let currentView        = 'student';
let selectedFeeItem    = null;
let currentSlipBase64  = null;
let currentSlipQRData  = null;
let currentPaymentQty  = 1;
let feeItems           = [];
let submissions        = [];

let appInitialized     = false;   // กัน init ซ้ำ

// ==========================================
// LOAD LOCAL DATA
// ==========================================

try {
  feeItems = JSON.parse(lsGet(K_FEE_ITEMS)) || DEFAULT_FEE_ITEMS;
} catch (e) {
  feeItems = DEFAULT_FEE_ITEMS;
}

try {
  submissions = JSON.parse(lsGet(K_SUBMISSIONS)) || [];
} catch (e) {
  submissions = [];
}

// ==========================================
// NORMALIZE HELPERS
// ==========================================

/**
 * ตัดช่องว่าง, quote, zero-width, nbsp ออก
 * ใช้ก่อนเทียบรหัสนักศึกษาเสมอ
 */
function normId(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/[\s'"\u200b\u00a0]/g, '')
    .toLowerCase();
}

function isEmailLike(v) {
  return /^\S+@\S+\.\S+$/.test(String(v || '').trim());
}

function normalizeStatus(st) {

  if (!st) return 'Pending';

  const str = st.toString().trim().toLowerCase();

  if (
    str.includes('approved') ||
    str.includes('อนุมัติ')  ||
    str.includes('ชำระแล้ว') ||
    str.includes('paid')
  ) {
    // ระวังคำว่า "ไม่อนุมัติ" ต้องไม่ถูกจับเป็น Approved
    if (str.includes('ไม่อนุมัติ') || str.includes('ไม่ผ่าน')) {
      return 'Rejected';
    }
    return 'Approved';
  }

  if (
    str.includes('reject') ||
    str.includes('ปฏิเสธ')  ||
    str.includes('ไม่อนุมัติ')
  ) {
    return 'Rejected';
  }

  return 'Pending';
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================

async function bootstrapApp() {

  if (appInitialized) {
    console.log('[INIT] Already initialized, skip');
    return;
  }

  appInitialized = true;

  setupDragAndDrop();
  checkGasConfigAlert();

  // ----------------------------------------
  // ADMIN PAGE
  // ----------------------------------------

  if (window.location.pathname.toLowerCase().includes('admin.html')) {

    currentView = 'admin';

    await Promise.allSettled([
      fetchSubmissionsFromGas(),
      fetchFeeItemsFromGas(),
      fetchSystemConfigFromGas()
    ]);

    renderAdminDashboard();
    return;
  }

  // ----------------------------------------
  // 1. RESTORE SAVED SESSION
  // ----------------------------------------

  const restored = checkSavedSession();

  if (restored) {
    console.log('[INIT] Session restored from storage');
  } else {

    // ------------------------------------
    // 2. LIFF AUTO LOGIN (กู้ session)
    // ------------------------------------

    console.log('[INIT] No saved session. Trying LIFF...');

    const liffLoggedIn = await checkLiffAutoLogin();

    if (!liffLoggedIn) {
      showLoginScreen();
      checkLineAuthCode();
    }
  }

  // ----------------------------------------
  // 3. โหลดข้อมูลจากชีทเสมอ
  // ----------------------------------------

  await Promise.allSettled([
    fetchSubmissionsFromGas(),
    fetchFeeItemsFromGas(),
    fetchSystemConfigFromGas()
  ]);

  if (currentUser) {
    renderStudentDashboard();
  }
}

/**
 * สำคัญ: ถ้าสคริปต์ถูกโหลดแบบ defer/async หรือโหลดช้า
 * DOMContentLoaded อาจยิงไปแล้ว ทำให้ init ไม่ทำงานเลย
 * และหน้าค้างที่ login ทุกครั้ง
 */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}

// ==========================================
// FETCH PAYMENTS FROM GOOGLE SHEET
// ==========================================

async function fetchSubmissionsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) return;

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (CONFIG.GOOGLE_SCRIPT_URL.includes('?') ? '&' : '?') +
      'action=getPayments&t=' + Date.now();

    const response = await fetch(url);
    const result   = await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      // debug: ดูชื่อคอลัมน์จริงที่ GAS ส่งมา
      if (result.data.length > 0) {
        console.log('[Sheet] Columns:', Object.keys(result.data[0]));
      }

      const sheetSubmissions = result.data.map((row, idx) => {

        const identity = String(
          row['ข้อมูลประจำตัว/รหัส'] ||
          row['รหัสนักศึกษา']      ||
          row['เลขประจำตัว']       ||
          row['studentId']         ||
          row['studentID']         ||
          ''
        ).trim();

        const identityIsEmail = isEmailLike(identity);

        // FIX: เดิมบังคับ /^\d{8}$/ ทำให้รหัสที่มีช่องว่าง
        // หรือความยาวต่างไป กลายเป็นค่าว่าง แล้ว match ไม่ติด
        const rawStudentId =
          row['รหัสนักศึกษา'] ||
          row['เลขประจำตัว']  ||
          row['studentId']    ||
          row['studentID']    ||
          (!identityIsEmail ? identity : '');

        const rawEmail =
          row['อีเมลนักศึกษา'] ||
          row['email']         ||
          (identityIsEmail ? identity : '');

        const rawLineUserId =
          row['LINE User ID'] ||
          row['lineUserId']   ||
          row['LINE ID']      ||
          '';

        return {

          id: row['id'] || row['ID'] || `gas-${idx}`,

          rowNumber:
            row['rowNumber'] ||
            row['_rowNumber'] ||
            (idx + 2),

          timestamp:   row['วันเวลาที่ส่ง'] ? String(row['วันเวลาที่ส่ง']) : '',
          studentName: row['ชื่อ-นามสกุล']  ? String(row['ชื่อ-นามสกุล'])  : '',

          studentId:    String(rawStudentId || '').trim(),
          studentEmail: String(rawEmail || '').trim(),
          email:        String(rawEmail || '').trim(),
          lineUserId:   String(rawLineUserId || '').trim(),

          feeId:   row['feeId'] || row['Fee ID'] || '',
          feeName: row['รายการชำระเงิน'] ? String(row['รายการชำระเงิน']) : '',

          amount: parseFloat(
            String(row['จำนวนเงิน (บาท)'] || row['จำนวนเงิน'] || 0)
              .replace(/[^0-9.\-]/g, '')
          ) || 0,

          status: normalizeStatus(row['สถานะ']),

          slipUrl:
            row['ลิงก์สลิปใน Google Drive']
              ? String(row['ลิงก์สลิปใน Google Drive'])
              : (row['slipUrl'] ? String(row['slipUrl']) : ''),

          slipBase64: row['slipBase64'] || '',

          qrRef:
            row['ข้อมูล QR Ref บนสลิป']
              ? String(row['ข้อมูล QR Ref บนสลิป'])
              : '',

          remark: row['หมายเหตุ'] ? String(row['หมายเหตุ']) : ''
        };
      });

      submissions = sheetSubmissions;

      lsSet(K_SUBMISSIONS, JSON.stringify(submissions));

      console.log('[Sheet] Payments loaded:', submissions.length);

      if (currentView === 'admin') renderAdminDashboard();
      if (currentUser) renderStudentDashboard();
    }

  } catch (err) {
    console.warn('[Sheet] Fetch submissions error:', err);
  }
}

// ==========================================
// FETCH FEE ITEMS
// ==========================================

async function fetchFeeItemsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) return;

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (CONFIG.GOOGLE_SCRIPT_URL.includes('?') ? '&' : '?') +
      'action=getFeeItems&t=' + Date.now();

    const response = await fetch(url);
    const result   = await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      const cloudItems = result.data.map(item => {

        let cleanDueDate = item.dueDate ? String(item.dueDate) : '';

        if (cleanDueDate.includes('GMT') || cleanDueDate.includes('T')) {
          try {
            cleanDueDate = new Date(cleanDueDate).toISOString().split('T')[0];
          } catch (e) {}
        }

        return {
          id:          item.id || `fee-${Date.now()}`,
          category:    item.category || 'ค่าห้อง',
          name:        item.name || '',
          description: item.description || '',
          amount:      parseFloat(item.amount) || 0,
          dueDate:     cleanDueDate
        };
      });

      if (cloudItems.length > 0) {
        feeItems = cloudItems;
        saveFeeItemsToStorage();
      }

      renderStudentDashboard();
      renderAdminDashboard();
    }

  } catch (err) {
    console.warn('[Sheet] Fetch fee items error:', err);
  }
}

// ==========================================
// LIFF AUTO LOGIN
// ==========================================

async function checkLiffAutoLogin() {

  // FIX: ย้ายจาก sessionStorage -> localStorage
  // เดิมปิดแท็บแล้ว flag หาย ทำให้พฤติกรรมไม่คงที่
  if (lsGet(K_LOGOUT) === '1') {
    console.log('[LIFF] Auto login skipped (manual logout)');
    return false;
  }

  if (currentUser) return true;

  if (!CONFIG.LIFF_ID || typeof liff === 'undefined') {
    console.log('[LIFF] SDK not available');
    return false;
  }

  try {

    await liff.init({ liffId: CONFIG.LIFF_ID });

    console.log('[LIFF] Initialized');

    if (
      typeof liff.isLoggedIn === 'function' &&
      liff.isLoggedIn()
    ) {

      const profile = await liff.getProfile();

      if (!profile) return false;

      await processLiffProfile(profile);

      return !!currentUser;
    }

  } catch (err) {
    console.warn('[LIFF] Auto login error:', err);
  }

  return false;
}

// ==========================================
// LOGIN SCREEN
// ==========================================

function showLoginScreen() {

  const show = (id, mode) => {
    const el = document.getElementById(id);
    if (el) el.style.display = mode;
  };

  show('loginSection',    'block');
  show('registerSection', 'none');
  show('mainAppSection',  'none');
  show('navControls',     'none');
  show('navAdminLink',    'none');
}

// ==========================================
// REMEMBER LOGIN
// ==========================================

function checkSavedSession() {

  const savedUser = lsGet(K_USER);

  console.log('[Session] Checking saved session:', savedUser);

  if (savedUser) {

    try {

      const user = JSON.parse(savedUser);

      // FIX: เดิมบังคับต้องมี studentId เท่านั้น
      // ถ้า login ผ่าน LINE แล้วชีทคืนรหัสว่าง จะเด้งออกทุกครั้ง
      if (user && (user.studentId || user.lineUserId)) {

        currentUser = user;

        console.log('[Session] Restored user:', currentUser);

        showMainApplication(currentUser);

        return true;
      }

    } catch (e) {
      console.error('[Session] Restore failed:', e);
      lsRemove(K_USER);
    }
  }

  console.log('[Session] No saved session');

  showLoginScreen();

  return false;
}

// ==========================================
// GOOGLE SIGN-IN
// ==========================================

function initGoogleSignIn() {

  const btnContainer = document.getElementById('g_id_signin_dynamic');
  const noteEl       = document.getElementById('googleSignInNote');

  if (!btnContainer) return;

  btnContainer.innerHTML = '';

  if (!CONFIG.GOOGLE_CLIENT_ID) {
    if (noteEl) noteEl.style.display = 'block';
    return;
  }

  if (noteEl) noteEl.style.display = 'none';

  setTimeout(() => {

    if (typeof google !== 'undefined') {

      try {

        google.accounts.id.initialize({
          client_id:   CONFIG.GOOGLE_CLIENT_ID,
          callback:    handleGoogleSignIn,
          context:     'signin',
          ux_mode:     'popup',
          auto_select: false,
          itp_support: true
        });

        google.accounts.id.renderButton(btnContainer, {
          type:           'standard',
          shape:          'rectangular',
          theme:          'filled_blue',
          text:           'signin_with',
          size:           'large',
          logo_alignment: 'left'
        });

      } catch (err) {
        console.error('Google Sign-in rendering error:', err);
      }
    }

  }, 500);
}

// ==========================================
// LOCAL STORAGE HELPERS
// ==========================================

function saveFeeItemsToStorage() {
  lsSet(K_FEE_ITEMS, JSON.stringify(feeItems));
}

function saveConfigToStorage() {
  lsSet(K_CONFIG, JSON.stringify(CONFIG));
  checkGasConfigAlert();
}

// ==========================================
// GAS CONFIG ALERT
// ==========================================

function checkGasConfigAlert() {

  const alertBox = document.getElementById('gasStatusAlert');

  if (!alertBox) return;

  alertBox.style.display = 'block';

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    alertBox.innerHTML = `
      <div style="background:rgba(245,158,11,.15);border:1px solid rgba(245,158,11,.4);color:var(--color-warning);padding:12px 16px;border-radius:12px;font-size:.875rem;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL</strong>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">ตั้งค่าตอนนี้</button>
      </div>
    `;

  } else {

    alertBox.innerHTML = `
      <div style="background:rgba(16,185,129,.15);border:1px solid rgba(16,185,129,.4);color:var(--color-success);padding:12px 16px;border-radius:12px;font-size:.875rem;display:flex;align-items:center;justify-content:space-between;">
        <div>
          <i class="fa-solid fa-circle-check"></i>
          <strong>เชื่อมต่อ Google Apps Script เรียบร้อย</strong>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="openConfigModal()">แก้ไขตั้งค่า</button>
      </div>
    `;
  }
}

// ==========================================
// LINE AUTH CODE
// ==========================================

function checkLineAuthCode() {

  const urlParams = new URLSearchParams(window.location.search);
  const code      = urlParams.get('code');

  if (!code) return;

  window.history.replaceState({}, document.title, window.location.pathname);

  if (typeof processLineLogin === 'function') {
    processLineLogin(code);
  }
}

function getRedirectUri() {

  let uri = window.location.origin + window.location.pathname;

  if (uri.length > 1 && uri.endsWith('/')) {
    uri = uri.slice(0, -1);
  }

  return uri;
}

// ==========================================
// LINE LOGIN
// ==========================================

async function loginWithLine() {

  lsRemove(K_LOGOUT);

  if (CONFIG.LIFF_ID && typeof liff !== 'undefined') {

    showToast('กำลังเชื่อมต่อ LINE...', 'info');

    try {

      await liff.init({ liffId: CONFIG.LIFF_ID });

      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return;
      }

      const profile = await liff.getProfile();

      await processLiffProfile(profile);

      return;

    } catch (err) {
      console.warn('LIFF init failed:', err);
    }
  }

  if (!CONFIG.LINE_CHANNEL_ID) {
    showToast('กรุณาตั้งค่า LINE Channel ID', 'error');
    return;
  }

  const redirectUri = encodeURIComponent(getRedirectUri());
  const state       = 'state-' + Date.now();

  window.location.href =
    `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CONFIG.LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;
}

// ==========================================
// PROCESS LIFF PROFILE
// ==========================================

async function processLiffProfile(profile) {

  if (!profile) return;

  const lineUserId = profile.userId;
  const lineName   = profile.displayName || 'LINE User';
  const picture    = profile.pictureUrl || '';

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL', 'error');
    return;
  }

  showToast('กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...', 'info');

  try {

    const url =
      `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkLineUser&lineUserId=${encodeURIComponent(lineUserId)}&t=${Date.now()}`;

    const response = await fetch(url);
    const result   = await response.json();

    if (result && result.status === 'success') {

      if (result.registered) {

        const userData = {
          lineUserId: lineUserId,
          name:       result.name || lineName,
          studentId:  String(result.studentId || '').trim(),
          email:      String(result.email || '').trim(),
          picture:    picture
        };

        if (!userData.studentId) {
          showToast('ไม่พบรหัสนักศึกษาที่เชื่อมกับ LINE นี้', 'error');
          return;
        }

        saveUserSession(userData);
        showMainApplication(userData);

        showToast(`ยินดีต้อนรับกลับ คุณ ${userData.name}!`, 'success');

      } else {
        showRegistrationScreen(lineUserId, lineName);
      }

    } else {
      showToast(result.message || 'ไม่สามารถตรวจสอบข้อมูลกับเซิร์ฟเวอร์ได้', 'error');
    }

  } catch (err) {
    console.error('LIFF Profile Check Error:', err);
    showToast('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์', 'error');
  }
}

// ==========================================
// DIRECT STUDENT LOGIN
// ==========================================

async function handleDirectStudentLogin(e) {

  e.preventDefault();

  const input = document.getElementById('loginStudentIdInput');

  if (!input) return;

  const studentId = input.value.trim();

  if (!studentId) return;

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('กรุณาตั้งค่า Google Apps Script URL', 'error');
    return;
  }

  showToast('กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...', 'info');

  try {

    const response = await fetch(
      `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkStudentId&studentId=${encodeURIComponent(studentId)}&t=${Date.now()}`
    );

    const result = await response.json();

    if (result && result.status === 'success' && result.exists) {

      const userData = {
        studentId:  studentId,
        name:       result.name || `นักศึกษา รหัส ${studentId}`,
        email:      String(result.email || '').trim(),   // FIX: ไม่ใส่ 'direct_login'
        lineUserId: '',
        picture:    ''
      };

      saveUserSession(userData);
      showMainApplication(userData);

      showToast(`ยินดีต้อนรับคุณ ${userData.name}!`, 'success');

    } else {
      showToast(`ไม่พบรหัสนักศึกษา ${studentId} ในฐานข้อมูล`, 'error');
    }

  } catch (err) {
    console.warn('Direct login error:', err);
    showToast('ไม่สามารถเชื่อมต่อ Google Sheet ได้', 'error');
  }
}

// ==========================================
// SAVE USER SESSION
// ==========================================

function saveUserSession(userData) {

  if (!userData) return;

  ['studentId', 'lineUserId', 'name', 'email'].forEach(k => {
    if (userData[k]) userData[k] = String(userData[k]).trim();
  });

  currentUser = userData;

  lsSet(K_USER, JSON.stringify(userData));
  lsRemove(K_LOGOUT);

  console.log('[Session] Saved:', userData);
}

// ==========================================
// LOGOUT
// ==========================================

function logoutUser() {

  currentUser = null;

  lsRemove(K_USER);
  lsSet(K_LOGOUT, '1');

  try {
    if (
      typeof liff !== 'undefined' &&
      typeof liff.isLoggedIn === 'function' &&
      liff.isLoggedIn() &&
      typeof liff.logout === 'function'
    ) {
      liff.logout();
    }
  } catch (e) {
    console.warn('[LIFF] Logout warning:', e);
  }

  showLoginScreen();

  showToast('ออกจากระบบเรียบร้อยแล้ว', 'info');
}

// ==========================================
// MAIN APPLICATION
// ==========================================

function showMainApplication(user) {

  if (!user) return;

  currentUser = user;

  const name = user.name || `นักศึกษา รหัส ${user.studentId || ''}`;
  const displaySubtext = user.studentId || user.email || 'KMITL Student';

  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  setText('userName', name);
  setText('userEmail', displaySubtext);
  setText('welcomeStudentName', name);
  setText('userAvatar', name.trim().charAt(0).toUpperCase());

  const show = (id, mode) => {
    const el = document.getElementById(id);
    if (el) el.style.display = mode;
  };

  show('loginSection',    'none');
  show('registerSection', 'none');
  show('mainAppSection',  'block');
  show('navControls',     'flex');

  const navAdminLink = document.getElementById('navAdminLink');

  if (navAdminLink) {

    const adminIds = ['69010115', '69010165'];

    const isAdmin =
      user.studentId &&
      adminIds.some(id => normId(id) === normId(user.studentId));

    navAdminLink.style.display = isAdmin ? 'inline-flex' : 'none';
  }

  renderStudentDashboard();
}

// ==========================================
// VIEW SWITCHER
// ==========================================

function switchView(view) {

  currentView = view;

  const studentBtn  = document.getElementById('tabStudentBtn');
  const adminBtn    = document.getElementById('tabAdminBtn');
  const studentView = document.getElementById('studentView');
  const adminView   = document.getElementById('adminView');

  if (view === 'student') {

    if (studentBtn) studentBtn.classList.add('active');
    if (adminBtn)   adminBtn.classList.remove('active');
    if (studentView) studentView.style.display = 'block';
    if (adminView)   adminView.style.display = 'none';

    renderStudentDashboard();

  } else {

    if (adminBtn)   adminBtn.classList.add('active');
    if (studentBtn) studentBtn.classList.remove('active');
    if (studentView) studentView.style.display = 'none';
    if (adminView)   adminView.style.display = 'block';

    renderAdminDashboard();
  }
}

// ==========================================
// CHECK PAYMENT BELONGS TO CURRENT USER
// ==========================================

function isSubmissionForCurrentUser(sub) {

  if (!currentUser || !sub) return false;

  // FIX: ใช้ normId ทุกฝั่ง
  // เดิมใช้ .trim() อย่างเดียว ทำให้รหัสที่มี ' นำหน้า
  // หรือมี nbsp จากชีท match ไม่ติด -> ประวัติไม่ขึ้น
  const curId    = normId(currentUser.studentId);
  const curLine  = normId(currentUser.lineUserId);
  const curEmail = normId(currentUser.email);
  const curName  = String(currentUser.name || '').trim();

  const subId    = normId(sub.studentId);
  const subLine  = normId(sub.lineUserId);
  const subEmail = normId(sub.studentEmail || sub.email);
  const subName  = String(sub.studentName || '').trim();

  // PRIMARY: รหัสนักศึกษา
  if (curId && subId && curId === subId) return true;

  // SECONDARY: LINE User ID
  if (curLine && subLine && curLine === subLine) return true;

  // EMAIL
  if (
    curEmail &&
    curEmail !== 'direct_login' &&
    subEmail &&
    curEmail === subEmail
  ) {
    return true;
  }

  // กรณีชีทเก็บรหัสไว้ในช่องอีเมล (ข้อมูลเก่า)
  if (curId && subEmail && curId === subEmail) return true;

  // LAST FALLBACK: ชื่อ
  if (curName && subName && curName === subName) return true;

  return false;
}

// ==========================================
// STUDENT DASHBOARD
// ==========================================

function renderStudentDashboard() {

  const grid = document.getElementById('feeItemsGrid');

  if (!grid) return;

  grid.innerHTML = '';

  if (!currentUser) return;

  const userSubsAll = submissions.filter(isSubmissionForCurrentUser);

  console.log('[Dashboard] User:', currentUser);
  console.log('[Dashboard] Matched payments:', userSubsAll.length, 'of', submissions.length);

  let unpaidTotal  = 0;
  let paidTotal    = 0;
  let pendingCount = 0;

  const setStat = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  if (feeItems.length === 0) {

    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:3rem;color:var(--text-muted);">
        ไม่มีรายการเก็บเงินในระบบขณะนี้
      </div>
    `;

    setStat('statUnpaid', '฿0');
    setStat('statPaid', '฿0');
    setStat('statPending', '0 รายการ');

    renderStudentHistoryTable();
    return;
  }

  feeItems.forEach(item => {

    const itemAmount = parseFloat(item.amount) || 0;

    const relatedSubs = userSubsAll.filter(sub => {

      const sameFeeId =
        sub.feeId && item.id &&
        String(sub.feeId).trim() === String(item.id).trim();

      const sameFeeName =
        sub.feeName && item.name &&
        String(sub.feeName).trim() === String(item.name).trim();

      return sameFeeId || sameFeeName;
    });

    const approvedSubs = relatedSubs.filter(s => normalizeStatus(s.status) === 'Approved');
    const pendingSubs  = relatedSubs.filter(s => normalizeStatus(s.status) === 'Pending');

    const paidAmount = approvedSubs.reduce(
      (sum, s) => sum + (parseFloat(s.amount) || 0), 0
    );

    const remaining = Math.max(0, itemAmount - paidAmount);

    paidTotal    += paidAmount;
    unpaidTotal  += remaining;
    pendingCount += pendingSubs.length;

    let statusBadge   = '';
    let paymentButton = '';

    if (paidAmount >= itemAmount && itemAmount > 0) {

      statusBadge = `
        <span class="fee-badge badge-paid">
          <i class="fa-solid fa-check"></i> ชำระแล้ว
        </span>
      `;

      paymentButton = `
        <button class="btn btn-secondary" style="width:100%;opacity:.7;cursor:not-allowed;" disabled>
          <i class="fa-solid fa-circle-check"></i> ชำระแล้ว
        </button>
      `;

    } else if (pendingSubs.length > 0) {

      statusBadge = `
        <span class="fee-badge badge-pending">
          <i class="fa-solid fa-clock"></i> รอตรวจสอบ
        </span>
      `;

      paymentButton = `
        <button class="btn btn-secondary" style="width:100%;opacity:.7;cursor:not-allowed;" disabled>
          <i class="fa-solid fa-clock"></i> รอตรวจสอบ
        </button>
      `;

    } else {

      statusBadge = `
        <span class="fee-badge badge-unpaid">
          <i class="fa-solid fa-circle-exclamation"></i> ยังไม่ได้จ่าย
        </span>
      `;

      paymentButton = `
        <button class="btn btn-primary" style="width:100%"
          onclick="openPaymentModal('${String(item.id).replace(/'/g, "\\'")}')">
          <i class="fa-solid fa-qrcode"></i> ชำระเงิน / แนบสลิป
        </button>
      `;
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
            <strong>฿${itemAmount.toLocaleString()}</strong>
          </div>
          <div class="fee-due">
            <i class="fa-regular fa-calendar"></i>
            ครบกำหนด: ${escapeHtml(item.dueDate || '-')}
          </div>
        </div>
        ${paymentButton}
      </div>
    `;

    grid.appendChild(card);
  });

  setStat('statUnpaid', `฿${unpaidTotal.toLocaleString()}`);
  setStat('statPaid', `฿${paidTotal.toLocaleString()}`);
  setStat('statPending', `${pendingCount} รายการ`);

  renderStudentHistoryTable();
}

// ==========================================
// STUDENT HISTORY
// ==========================================

function renderStudentHistoryTable() {

  const tbody = document.getElementById('studentHistoryTable');

  if (!tbody) return;

  tbody.innerHTML = '';

  if (!currentUser) return;

  const userSubs = submissions.filter(isSubmissionForCurrentUser);

  if (userSubs.length === 0) {

    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">
          ยังไม่มีประวัติการส่งสลิปชำระเงิน
        </td>
      </tr>
    `;

    return;
  }

  userSubs.forEach(sub => {

    const normStatus = normalizeStatus(sub.status);

    let statusClass = 'badge-unpaid';
    let statusText  = 'ไม่ผ่าน';

    if (normStatus === 'Approved') {
      statusClass = 'badge-paid';
      statusText  = 'อนุมัติเรียบร้อย';
    } else if (normStatus === 'Pending') {
      statusClass = 'badge-pending';
      statusText  = 'รอเหรัญญิกตรวจ';
    }

    const driveBtn = sub.slipUrl
      ? `<a href="${escapeHtml(sub.slipUrl)}" target="_blank" rel="noopener" class="btn btn-secondary btn-sm">
           <i class="fa-solid fa-external-link"></i> เปิด Drive
         </a>`
      : `<span style="color:var(--text-muted);font-size:.8rem;">ยังไม่มีไฟล์</span>`;

    const tr = document.createElement('tr');

    tr.innerHTML = `
      <td>${escapeHtml(sub.timestamp || '-')}</td>
      <td><strong>${escapeHtml(sub.feeName || '-')}</strong></td>
      <td>฿${(parseFloat(sub.amount) || 0).toLocaleString()}</td>
      <td>
        <button class="btn btn-secondary btn-sm"
          onclick="viewAdminSlip('${String(sub.id).replace(/'/g, "\\'")}')">
          <i class="fa-solid fa-image"></i> ดูสลิป
        </button>
      </td>
      <td><span class="fee-badge ${statusClass}">${statusText}</span></td>
      <td>${driveBtn}</td>
    `;

    tbody.appendChild(tr);
  });
}

// ==========================================
// PROMPTPAY
// ==========================================

function generatePromptPayQRPayload(target, amount) {

  const sanitize = String(target || '').replace(/[^0-9]/g, '');

  let targetType      = '01';
  let formattedTarget = sanitize;

  if (sanitize.length === 10) {
    formattedTarget = '0066' + sanitize.substring(1);
    targetType      = '01';
  } else if (sanitize.length === 13) {
    targetType = '02';
  }

  const amountStr = amount ? amount.toFixed(2) : '0.00';
  const amountLen = ('0' + amountStr.length).slice(-2);

  const payload =
    `00020101021129370016A000000677010111${targetType}${('0' + formattedTarget.length).slice(-2)}${formattedTarget}5802TH5303764${
      amount ? '54' + amountLen + amountStr : ''
    }6304`;

  return payload + crc16(payload);
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
// PAYMENT MODAL
// ==========================================

function getFeeStatusForCurrentUser(feeItem) {

  const userSubs = submissions.filter(isSubmissionForCurrentUser);

  const relatedSubs = userSubs.filter(sub =>
    (sub.feeId && String(sub.feeId) === String(feeItem.id)) ||
    (sub.feeName && String(sub.feeName).trim() === String(feeItem.name).trim())
  );

  const approved = relatedSubs.filter(s => normalizeStatus(s.status) === 'Approved');
  const pending  = relatedSubs.filter(s => normalizeStatus(s.status) === 'Pending');

  const paidAmount = approved.reduce(
    (sum, s) => sum + (parseFloat(s.amount) || 0), 0
  );

  return { relatedSubs, approved, pending, paidAmount };
}

function openPaymentModal(feeId) {

  selectedFeeItem = feeItems.find(f => String(f.id) === String(feeId));

  if (!selectedFeeItem) return;

  const { pending, paidAmount } = getFeeStatusForCurrentUser(selectedFeeItem);

  if (paidAmount >= Number(selectedFeeItem.amount)) {
    showToast('รายการนี้ชำระแล้ว', 'info');
    renderStudentDashboard();
    return;
  }

  if (pending.length > 0) {
    showToast('รายการนี้มีสลิปที่กำลังรอตรวจสอบอยู่', 'info');
    renderStudentDashboard();
    return;
  }

  currentPaymentQty = 1;

  const modalTitle = document.getElementById('modalFeeTitle');

  if (modalTitle) {
    modalTitle.textContent = `ชำระเงิน: ${selectedFeeItem.name}`;
  }

  const receiver = document.getElementById('modalPromptPayReceiver');

  if (receiver) {
    receiver.textContent =
      `ชื่อบัญชี: ${CONFIG.PROMPTPAY_NAME} (PromptPay: ${maskPromptPay(CONFIG.PROMPTPAY_NUMBER)})`;
  }

  resetSlipUploader();
  updatePaymentQR();

  const modal = document.getElementById('paymentModal');

  if (modal) modal.classList.add('active');
}

function changePaymentQty(delta) {

  const newQty = currentPaymentQty + delta;

  if (newQty < 1 || newQty > 10) return;

  currentPaymentQty = newQty;

  updatePaymentQR();
}

function updatePaymentQR() {

  if (!selectedFeeItem) return;

  const unitPrice   = Number(selectedFeeItem.amount) || 0;
  const totalAmount = unitPrice * currentPaymentQty;

  const qtyValue = document.getElementById('qtyValue');
  if (qtyValue) qtyValue.textContent = currentPaymentQty;

  const qtyMinus = document.getElementById('qtyMinus');
  if (qtyMinus) qtyMinus.disabled = currentPaymentQty <= 1;

  const qtyPlus = document.getElementById('qtyPlus');
  if (qtyPlus) qtyPlus.disabled = currentPaymentQty >= 10;

  const qtySummaryText = document.getElementById('qtySummaryText');

  if (qtySummaryText) {
    qtySummaryText.textContent =
      `฿${unitPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })} × ${currentPaymentQty} = `;
  }

  const qtySummaryTotal = document.getElementById('qtySummaryTotal');

  if (qtySummaryTotal) {
    qtySummaryTotal.textContent =
      `฿${totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  }

  const amountEl = document.getElementById('modalPromptPayAmount');

  if (amountEl) amountEl.textContent = `฿${totalAmount.toFixed(2)}`;

  const payload = generatePromptPayQRPayload(CONFIG.PROMPTPAY_NUMBER, totalAmount);

  const qrImg = document.getElementById('qrImg');

  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;
    qrImg.style.display = 'block';
  }

  const qrCanvas = document.getElementById('qrCanvas');

  if (typeof QRCode !== 'undefined' && qrCanvas) {

    QRCode.toCanvas(qrCanvas, payload, { width: 220, margin: 2 }, error => {

      if (!error) {
        qrCanvas.style.display = 'block';
        if (qrImg) qrImg.style.display = 'none';
      }
    });
  }
}

function closeModal(modalId) {

  const modal = document.getElementById(modalId);

  if (modal) modal.classList.remove('active');
}

// ==========================================
// DRAG & DROP
// ==========================================

function setupDragAndDrop() {

  const dropzone = document.getElementById('slipDropzone');

  if (!dropzone) return;

  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', e => {

    const files = e.dataTransfer.files;

    if (files && files.length > 0) {
      processSelectedSlip(files[0]);
    }
  });
}

function handleFileSelect(e) {

  const files = e.target.files;

  if (files && files.length > 0) {
    processSelectedSlip(files[0]);
  }
}

// ==========================================
// SLIP PROCESSING
// ==========================================

function processSelectedSlip(file) {

  if (!file || !file.type.startsWith('image/')) {
    showToast('กรุณาเลือกไฟล์รูปภาพสลิปเท่านั้น', 'error');
    return;
  }

  const reader = new FileReader();

  reader.onload = function (evt) {

    const previewBox = document.getElementById('slipPreviewBox');
    const previewImg = document.getElementById('slipPreviewImg');
    const scanStatus = document.getElementById('slipScanResult');

    if (scanStatus) {
      scanStatus.innerHTML =
        `<i class="fa-solid fa-spinner fa-spin"></i> กำลังประมวลผลและบีบอัดรูปภาพสลิป...`;
    }

    const img = new Image();

    img.onload = function () {

      try {

        const canvas = document.createElement('canvas');

        let w = img.width;
        let h = img.height;

        // FIX: ลดขนาดลงจาก 1200 -> 1000 และคุณภาพ 0.78
        // ให้ base64 เล็กลง ส่งผ่าน form POST ได้เสถียรขึ้น
        const MAX_DIM = 1000;

        if (w > MAX_DIM || h > MAX_DIM) {
          if (w > h) {
            h = Math.round((h * MAX_DIM) / w);
            w = MAX_DIM;
          } else {
            w = Math.round((w * MAX_DIM) / h);
            h = MAX_DIM;
          }
        }

        canvas.width  = w;
        canvas.height = h;

        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        currentSlipBase64 = canvas.toDataURL('image/jpeg', 0.78);

        console.log(
          '[Slip] base64 size:',
          Math.round(currentSlipBase64.length / 1024) + ' KB'
        );

        if (previewImg) previewImg.src = currentSlipBase64;
        if (previewBox) previewBox.style.display = 'block';

        if (typeof jsQR !== 'undefined') {

          const imageData = ctx.getImageData(0, 0, w, h);

          const code = jsQR(
            imageData.data,
            imageData.width,
            imageData.height,
            { inversionAttempts: 'dontInvert' }
          );

          if (code) {

            currentSlipQRData = code.data;

            if (scanStatus) {
              scanStatus.innerHTML = `
                <i class="fa-solid fa-circle-check" style="color:var(--color-success)"></i>
                <span>ตรวจพบ QR Code บนสลิปเรียบร้อย</span>
              `;
            }

            showToast('สแกน QR Code บนสลิปเรียบร้อย', 'success');
            return;
          }
        }

      } catch (err) {

        console.warn('QR scanner / compression error:', err);

        currentSlipBase64 = evt.target.result;

        if (previewImg) previewImg.src = currentSlipBase64;
        if (previewBox) previewBox.style.display = 'block';
      }

      currentSlipQRData = null;

      if (scanStatus) {
        scanStatus.innerHTML = `
          <i class="fa-solid fa-circle-check" style="color:var(--color-success)"></i>
          รูปภาพสลิปพร้อมส่งแล้ว
        `;
      }

      showToast('รูปสลิปพร้อมส่งแล้ว', 'success');
    };

    img.onerror = function () {

      currentSlipBase64 = evt.target.result;

      if (previewImg) previewImg.src = currentSlipBase64;
      if (previewBox) previewBox.style.display = 'block';

      const scanStatus2 = document.getElementById('slipScanResult');
      if (scanStatus2) scanStatus2.innerHTML = 'รูปภาพสลิปพร้อมส่งแล้ว';
    };

    img.src = evt.target.result;
  };

  reader.onerror = function () {
    showToast('เกิดข้อผิดพลาดในการอ่านไฟล์รูปภาพ', 'error');
  };

  reader.readAsDataURL(file);
}

// ==========================================
// RESET SLIP
// ==========================================

function resetSlipUploader() {

  currentSlipBase64 = null;
  currentSlipQRData = null;

  const slipInput = document.getElementById('slipInput');
  if (slipInput) slipInput.value = '';

  const previewBox = document.getElementById('slipPreviewBox');
  if (previewBox) previewBox.style.display = 'none';

  const remark = document.getElementById('paymentRemark');
  if (remark) remark.value = '';
}

// ==========================================
// SUBMIT PAYMENT
// ==========================================

async function handlePaymentSubmit(e) {

  e.preventDefault();

  if (!currentUser) {
    showToast('กรุณาเข้าสู่ระบบก่อนชำระเงิน', 'error');
    return;
  }

  if (!selectedFeeItem) {
    showToast('ไม่พบรายการชำระเงิน', 'error');
    return;
  }

  if (!currentSlipBase64) {

    showToast('กรุณาเลือกรูปภาพสลิปก่อนส่ง', 'info');

    const slipInput = document.getElementById('slipInput');
    if (slipInput) slipInput.click();

    return;
  }

  const { pending, paidAmount } = getFeeStatusForCurrentUser(selectedFeeItem);

  if (paidAmount >= Number(selectedFeeItem.amount)) {
    showToast('รายการนี้ชำระแล้ว', 'info');
    closeModal('paymentModal');
    return;
  }

  if (pending.length > 0) {
    showToast('รายการนี้มีสลิปกำลังรอตรวจสอบ', 'info');
    closeModal('paymentModal');
    return;
  }

  const submitBtn = document.getElementById('btnSubmitPayment');

  if (!submitBtn) return;

  const studentName = currentUser.name || 'นักศึกษา KMITL';
  const studentId   = String(currentUser.studentId || '').trim();
  const lineUserId  = String(currentUser.lineUserId || '').trim();

  if (!studentId) {
    showToast('ไม่พบรหัสนักศึกษาใน Session', 'error');
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    showToast('ยังไม่ได้ตั้งค่า Google Apps Script URL', 'error');
    return;
  }

  submitBtn.disabled  = true;
  submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> กำลังอัปโหลดสลิปขึ้น Google Drive...`;

  const remarkEl = document.getElementById('paymentRemark');

  const newSubmission = {

    action: 'submitPayment',

    id: 'sub-' + Date.now(),

    studentName: studentName,
    studentId:   studentId,
    lineUserId:  lineUserId,

    // FIX: เดิมใส่ studentEmail = studentId
    // ทำให้รหัสไปโผล่ในช่องอีเมล แล้วการ match เพี้ยน
    studentEmail: String(currentUser.email || '').trim(),

    feeId:   selectedFeeItem.id,
    feeName: selectedFeeItem.name,

    amount: Number(selectedFeeItem.amount) * currentPaymentQty,

    status: 'Pending',

    tim... (เหลืออีก 24 KB)
