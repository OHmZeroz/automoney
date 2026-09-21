/**
 * KMITL Class Payment System - Core Application Logic
 *
 * FIXED VERSION
 * - Remember login after refresh
 * - Session restored BEFORE LIFF
 * - Prevent duplicate initialization
 * - Google Sheet is source of truth for payments
 * - Correct student identity matching
 * - Prevent showing another student's payments
 * - Paid item cannot be paid again
 * - Pending item cannot be submitted again
 * - No fake local payment append
 * - Admin status refreshes from Google Sheet
 * - Safer null handling
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
// CONFIGURATION
// ==========================================

let CONFIG = {};

try {
  CONFIG =
    JSON.parse(
      localStorage.getItem('kmitl_pay_config')
    ) || {};
} catch (e) {
  CONFIG = {};
}

if (!CONFIG.GOOGLE_SCRIPT_URL) {
  CONFIG.GOOGLE_SCRIPT_URL =
    'https://script.google.com/macros/s/AKfycbw_OxjIFz_N6wJzF_fFhoJE6P561_jBoWMs8WDO9q8b1RsnYdaDtormoQnupF1oHQ8J/exec';
}

CONFIG.LINE_CHANNEL_ID =
  CONFIG.LINE_CHANNEL_ID || '2010801650';

CONFIG.LINE_CHANNEL_SECRET =
  CONFIG.LINE_CHANNEL_SECRET || '';

CONFIG.LIFF_ID =
  CONFIG.LIFF_ID || '2010801650-te43AoZe';

if (!CONFIG.PROMPTPAY_NUMBER) {
  CONFIG.PROMPTPAY_NUMBER = '0891234567';
}

if (!CONFIG.PROMPTPAY_NAME) {
  CONFIG.PROMPTPAY_NAME =
    'เหรัญญิกประจำห้อง (KMITL Pay)';
}

if (
  CONFIG.ALLOW_NON_KMITL_IN_DEMO ===
  undefined
) {
  CONFIG.ALLOW_NON_KMITL_IN_DEMO = false;
}

localStorage.setItem(
  'kmitl_pay_config',
  JSON.stringify(CONFIG)
);

// ==========================================
// GLOBAL STATE
// ==========================================

let currentUser = null;
let currentView = 'student';

let selectedFeeItem = null;

let currentSlipBase64 = null;
let currentSlipQRData = null;

let currentPaymentQty = 1;

let feeItems = [];

let submissions = [];

// ==========================================
// LOAD LOCAL DATA
// ==========================================

try {
  feeItems =
    JSON.parse(
      localStorage.getItem(
        'kmitl_pay_fee_items'
      )
    ) || DEFAULT_FEE_ITEMS;
} catch (e) {
  feeItems = DEFAULT_FEE_ITEMS;
}

try {
  submissions =
    JSON.parse(
      localStorage.getItem(
        'kmitl_pay_submissions'
      )
    ) || [];
} catch (e) {
  submissions = [];
}

// ==========================================
// APPLICATION INITIALIZATION
// ==========================================

document.addEventListener(
  'DOMContentLoaded',
  async () => {

    setupDragAndDrop();
    checkGasConfigAlert();

    // ========================================
    // ADMIN PAGE
    // ========================================

    if (
      window.location.pathname
        .toLowerCase()
        .includes('admin.html')
    ) {

      currentView = 'admin';

      await Promise.allSettled([
        fetchSubmissionsFromGas(),
        fetchFeeItemsFromGas(),
        fetchSystemConfigFromGas()
      ]);

      renderAdminDashboard();

      return;
    }

    // ========================================
    // RESTORE SAVED SESSION FIRST
    // ========================================

    const restored =
      checkSavedSession();

    if (restored) {

      console.log(
        '[INIT] Session restored'
      );

      await Promise.allSettled([
        fetchSubmissionsFromGas(),
        fetchFeeItemsFromGas(),
        fetchSystemConfigFromGas()
      ]);

      if (currentUser) {
        showMainApplication(
          currentUser
        );
      }

      return;
    }

    // ========================================
    // NO LOCAL SESSION
    // CHECK LIFF
    // ========================================

    console.log(
      '[INIT] No saved session. Checking LIFF...'
    );

    const liffLoggedIn =
      await checkLiffAutoLogin();

    if (liffLoggedIn) {

      await Promise.allSettled([
        fetchSubmissionsFromGas(),
        fetchFeeItemsFromGas(),
        fetchSystemConfigFromGas()
      ]);

      return;
    }

    // ========================================
    // NO LOGIN
    // ========================================

    showLoginScreen();

    await Promise.allSettled([
      fetchSubmissionsFromGas(),
      fetchFeeItemsFromGas(),
      fetchSystemConfigFromGas()
    ]);

    checkLineAuthCode();
  }
);

// ==========================================
// STATUS NORMALIZER
// ==========================================

function normalizeStatus(st) {

  if (!st) {
    return 'Pending';
  }

  const str =
    st
      .toString()
      .trim()
      .toLowerCase();

  if (
    str.includes('approved') ||
    str.includes('อนุมัติ') ||
    str.includes('ชำระแล้ว') ||
    str.includes('paid')
  ) {
    return 'Approved';
  }

  if (
    str.includes('reject') ||
    str.includes('ปฏิเสธ') ||
    str.includes('ไม่อนุมัติ')
  ) {
    return 'Rejected';
  }

  return 'Pending';
}

// ==========================================
// FETCH PAYMENTS FROM GOOGLE SHEET
// ==========================================

async function fetchSubmissionsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getPayments&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      const sheetSubmissions =
        result.data.map(
          (row, idx) => {

            const identity =
              row['ข้อมูลประจำตัว/รหัส'] ||
              row['รหัสนักศึกษา'] ||
              row['เลขประจำตัว'] ||
              row['studentId'] ||
              row['studentID'] ||
              '';

            const rawStudentId =
              row['รหัสนักศึกษา'] ||
              row['เลขประจำตัว'] ||
              row['studentId'] ||
              row['studentID'] ||
              (
                /^\d{8}$/.test(
                  String(identity).trim()
                )
                  ? identity
                  : ''
              );

            const rawEmail =
              row['อีเมลนักศึกษา'] ||
              row['email'] ||
              (
                /^\S+@\S+\.\S+$/.test(
                  String(identity).trim()
                )
                  ? identity
                  : ''
              );

            const rawLineUserId =
              row['LINE User ID'] ||
              row['lineUserId'] ||
              row['LINE ID'] ||
              '';

            return {

              id:
                row['id'] ||
                row['ID'] ||
                `gas-${idx}`,

              rowNumber:
                row['rowNumber'] ||
                row['_rowNumber'] ||
                null,

              timestamp:
                row['วันเวลาที่ส่ง']
                  ? String(
                      row['วันเวลาที่ส่ง']
                    )
                  : '',

              studentName:
                row['ชื่อ-นามสกุล']
                  ? String(
                      row['ชื่อ-นามสกุล']
                    )
                  : '',

              studentId:
                String(
                  rawStudentId || ''
                ).trim(),

              studentEmail:
                String(
                  rawEmail || ''
                ).trim(),

              email:
                String(
                  rawEmail || ''
                ).trim(),

              lineUserId:
                String(
                  rawLineUserId || ''
                ).trim(),

              feeId:
                row['feeId'] ||
                row['Fee ID'] ||
                '',

              feeName:
                row['รายการชำระเงิน']
                  ? String(
                      row['รายการชำระเงิน']
                    )
                  : '',

              amount:
                parseFloat(
                  row['จำนวนเงิน (บาท)']
                ) || 0,

              status:
                normalizeStatus(
                  row['สถานะ']
                ),

              slipUrl:
                row[
                  'ลิงก์สลิปใน Google Drive'
                ]
                  ? String(
                      row[
                        'ลิงก์สลิปใน Google Drive'
                      ]
                    )
                  : '',

              slipBase64:
                row['slipBase64'] ||
                '',

              qrRef:
                row[
                  'ข้อมูล QR Ref บนสลิป'
                ]
                  ? String(
                      row[
                        'ข้อมูล QR Ref บนสลิป'
                      ]
                    )
                  : '',

              remark:
                row['หมายเหตุ']
                  ? String(
                      row['หมายเหตุ']
                    )
                  : ''
            };
          }
        );

      submissions =
        sheetSubmissions;

      localStorage.setItem(
        'kmitl_pay_submissions',
        JSON.stringify(
          submissions
        )
      );

      console.log(
        '[Sheet] Payments loaded:',
        submissions.length
      );

      if (
        currentView === 'admin'
      ) {
        renderAdminDashboard();
      }

      if (currentUser) {
        renderStudentDashboard();
      }
    }

  } catch (err) {

    console.warn(
      '[Sheet] Fetch submissions error:',
      err
    );
  }
}

// ==========================================
// FETCH FEE ITEMS
// ==========================================

async function fetchFeeItemsFromGas() {

  if (!CONFIG.GOOGLE_SCRIPT_URL) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getFeeItems&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status === 'success' &&
      Array.isArray(result.data)
    ) {

      const cloudItems =
        result.data.map(
          item => {

            let cleanDueDate =
              item.dueDate
                ? String(item.dueDate)
                : '';

            if (
              cleanDueDate.includes('GMT') ||
              cleanDueDate.includes('T')
            ) {

              try {

                const d =
                  new Date(
                    cleanDueDate
                  );

                cleanDueDate =
                  d
                    .toISOString()
                    .split('T')[0];

              } catch (e) {}
            }

            return {

              id:
                item.id ||
                `fee-${Date.now()}`,

              category:
                item.category ||
                'ค่าห้อง',

              name:
                item.name ||
                '',

              description:
                item.description ||
                '',

              amount:
                parseFloat(
                  item.amount
                ) || 0,

              dueDate:
                cleanDueDate
            };
          }
        );

      feeItems =
        cloudItems;

      saveFeeItemsToStorage();

      renderStudentDashboard();
      renderAdminDashboard();
    }

  } catch (err) {

    console.warn(
      '[Sheet] Fetch fee items error:',
      err
    );
  }
}

// ==========================================
// LIFF AUTO LOGIN
// ==========================================

async function checkLiffAutoLogin() {

  // ถ้าผู้ใช้เพิ่งกด logout
  if (
    sessionStorage.getItem(
      'kmitl_pay_manual_logout'
    ) === '1'
  ) {

    console.log(
      '[LIFF] Auto login skipped because of manual logout'
    );

    return false;
  }

  if (currentUser) {
    return true;
  }

  if (
    !CONFIG.LIFF_ID ||
    typeof liff === 'undefined'
  ) {
    return false;
  }

  try {

    await liff.init({
      liffId:
        CONFIG.LIFF_ID
    });

    console.log(
      '[LIFF] Initialized'
    );

    if (
      typeof liff.isLoggedIn ===
        'function' &&
      liff.isLoggedIn()
    ) {

      const profile =
        await liff.getProfile();

      if (!profile) {
        return false;
      }

      await processLiffProfile(
        profile
      );

      return !!currentUser;
    }

  } catch (err) {

    console.warn(
      '[LIFF] Auto login error:',
      err
    );
  }

  return false;
}

// ==========================================
// LOGIN SCREEN
// ==========================================

function showLoginScreen() {

  const loginSection =
    document.getElementById(
      'loginSection'
    );

  const registerSection =
    document.getElementById(
      'registerSection'
    );

  const mainAppSection =
    document.getElementById(
      'mainAppSection'
    );

  const navControls =
    document.getElementById(
      'navControls'
    );

  if (loginSection) {
    loginSection.style.display =
      'block';
  }

  if (registerSection) {
    registerSection.style.display =
      'none';
  }

  if (mainAppSection) {
    mainAppSection.style.display =
      'none';
  }

  if (navControls) {
    navControls.style.display =
      'none';
  }

  const navAdminLink =
    document.getElementById(
      'navAdminLink'
    );

  if (navAdminLink) {
    navAdminLink.style.display =
      'none';
  }
}

// ==========================================
// REMEMBER LOGIN
// ==========================================

function checkSavedSession() {

  const savedUser =
    localStorage.getItem(
      'kmitl_pay_user'
    );

  console.log(
    '[Session] Checking saved session:',
    savedUser
  );

  if (savedUser) {

    try {

      const user =
        JSON.parse(savedUser);

      if (
        user &&
        user.studentId
      ) {

        currentUser =
          user;

        console.log(
          '[Session] Restored user:',
          currentUser
        );

        showMainApplication(
          currentUser
        );

        return true;
      }

    } catch (e) {

      console.error(
        '[Session] Restore failed:',
        e
      );

      localStorage.removeItem(
        'kmitl_pay_user'
      );
    }
  }

  console.log(
    '[Session] No saved session'
  );

  showLoginScreen();

  return false;
}

// ==========================================
// GOOGLE SIGN-IN
// ==========================================

function initGoogleSignIn() {

  const btnContainer =
    document.getElementById(
      'g_id_signin_dynamic'
    );

  const noteEl =
    document.getElementById(
      'googleSignInNote'
    );

  if (!btnContainer) {
    return;
  }

  btnContainer.innerHTML = '';

  if (!CONFIG.GOOGLE_CLIENT_ID) {

    if (noteEl) {
      noteEl.style.display =
        'block';
    }

    return;
  }

  if (noteEl) {
    noteEl.style.display =
      'none';
  }

  setTimeout(() => {

    if (
      typeof google !==
      'undefined'
    ) {

      try {

        google.accounts.id.initialize({
          client_id:
            CONFIG.GOOGLE_CLIENT_ID,

          callback:
            handleGoogleSignIn,

          context:
            'signin',

          ux_mode:
            'popup',

          auto_select:
            false,

          itp_support:
            true
        });

        google.accounts.id.renderButton(
          btnContainer,
          {
            type:
              'standard',

            shape:
              'rectangular',

            theme:
              'filled_blue',

            text:
              'signin_with',

            size:
              'large',

            logo_alignment:
              'left'
          }
        );

      } catch (err) {

        console.error(
          'Google Sign-in rendering error:',
          err
        );
      }
    }

  }, 500);
}

// ==========================================
// LOCAL STORAGE HELPERS
// ==========================================

function saveFeeItemsToStorage() {

  localStorage.setItem(
    'kmitl_pay_fee_items',
    JSON.stringify(
      feeItems
    )
  );
}

function saveConfigToStorage() {

  localStorage.setItem(
    'kmitl_pay_config',
    JSON.stringify(
      CONFIG
    )
  );

  checkGasConfigAlert();
}

// ==========================================
// GAS CONFIG ALERT
// ==========================================

function checkGasConfigAlert() {

  const alertBox =
    document.getElementById(
      'gasStatusAlert'
    );

  if (!alertBox) {
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    alertBox.style.display =
      'block';

    alertBox.innerHTML = `
      <div style="
        background: rgba(245,158,11,.15);
        border:1px solid rgba(245,158,11,.4);
        color:var(--color-warning);
        padding:12px 16px;
        border-radius:12px;
        font-size:.875rem;
        display:flex;
        align-items:center;
        justify-content:space-between;
      ">
        <div>
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>ยังไม่ได้ระบุ Google Apps Script Web App URL</strong>
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          ตั้งค่าตอนนี้
        </button>
      </div>
    `;

  } else {

    alertBox.style.display =
      'block';

    alertBox.innerHTML = `
      <div style="
        background:rgba(16,185,129,.15);
        border:1px solid rgba(16,185,129,.4);
        color:var(--color-success);
        padding:12px 16px;
        border-radius:12px;
        font-size:.875rem;
        display:flex;
        align-items:center;
        justify-content:space-between;
      ">
        <div>
          <i class="fa-solid fa-circle-check"></i>
          <strong>เชื่อมต่อ Google Apps Script เรียบร้อย</strong>
        </div>

        <button
          class="btn btn-secondary btn-sm"
          onclick="openConfigModal()"
        >
          แก้ไขตั้งค่า
        </button>
      </div>
    `;
  }
}

// ==========================================
// LINE AUTH CODE
// ==========================================

function checkLineAuthCode() {

  const urlParams =
    new URLSearchParams(
      window.location.search
    );

  const code =
    urlParams.get('code');

  if (!code) {
    return;
  }

  window.history.replaceState(
    {},
    document.title,
    window.location.pathname
  );

  processLineLogin(code);
}

function getRedirectUri() {

  let uri =
    window.location.origin +
    window.location.pathname;

  if (
    uri.length > 1 &&
    uri.endsWith('/')
  ) {
    uri =
      uri.slice(
        0,
        -1
      );
  }

  return uri;
}

// ==========================================
// LINE LOGIN
// ==========================================

async function loginWithLine() {

  sessionStorage.removeItem(
    'kmitl_pay_manual_logout'
  );

  if (
    CONFIG.LIFF_ID &&
    typeof liff !== 'undefined'
  ) {

    showToast(
      'กำลังเชื่อมต่อ LINE...',
      'info'
    );

    try {

      await liff.init({
        liffId:
          CONFIG.LIFF_ID
      });

      if (!liff.isLoggedIn()) {

        liff.login({
          redirectUri:
            window.location.href
        });

        return;
      }

      const profile =
        await liff.getProfile();

      await processLiffProfile(
        profile
      );

      return;

    } catch (err) {

      console.warn(
        'LIFF init failed:',
        err
      );
    }
  }

  if (!CONFIG.LINE_CHANNEL_ID) {

    showToast(
      'กรุณาตั้งค่า LINE Channel ID',
      'error'
    );

    return;
  }

  const redirectUri =
    encodeURIComponent(
      getRedirectUri()
    );

  const state =
    'state-' +
    Date.now();

  const authUrl =
    `https://access.line.me/oauth2/v2.1/authorize?response_type=code&client_id=${CONFIG.LINE_CHANNEL_ID}&redirect_uri=${redirectUri}&state=${state}&scope=profile%20openid`;

  window.location.href =
    authUrl;
}

// ==========================================
// PROCESS LIFF PROFILE
// ==========================================

async function processLiffProfile(
  profile
) {

  if (!profile) {
    return;
  }

  const lineUserId =
    profile.userId;

  const lineName =
    profile.displayName ||
    'LINE User';

  const picture =
    profile.pictureUrl ||
    '';

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'ระบบไม่ได้ตั้งค่า Google Apps Script Web App URL',
      'error'
    );

    return;
  }

  showToast(
    'กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...',
    'info'
  );

  try {

    const url =
      `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkLineUser&lineUserId=${encodeURIComponent(lineUserId)}`;

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status ===
        'success'
    ) {

      if (
        result.registered
      ) {

        const userData = {

          lineUserId:
            lineUserId,

          name:
            result.name ||
            lineName,

          studentId:
            String(
              result.studentId ||
              ''
            ).trim(),

          picture:
            picture
        };

        if (
          !userData.studentId
        ) {

          showToast(
            'ไม่พบรหัสนักศึกษาที่เชื่อมกับ LINE นี้',
            'error'
          );

          return;
        }

        saveUserSession(
          userData
        );

        showMainApplication(
          userData
        );

        showToast(
          `ยินดีต้อนรับกลับ คุณ ${userData.name}!`,
          'success'
        );

      } else {

        showRegistrationScreen(
          lineUserId,
          lineName
        );
      }

    } else {

      showToast(
        result.message ||
        'ไม่สามารถตรวจสอบข้อมูลกับเซิร์ฟเวอร์ได้',
        'error'
      );
    }

  } catch (err) {

    console.error(
      'LIFF Profile Check Error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์',
      'error'
    );
  }
}

// ==========================================
// DIRECT STUDENT LOGIN
// ==========================================

async function handleDirectStudentLogin(
  e
) {

  e.preventDefault();

  const input =
    document.getElementById(
      'loginStudentIdInput'
    );

  if (!input) {
    return;
  }

  const studentId =
    input.value.trim();

  if (!studentId) {
    return;
  }

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    showToast(
      'กรุณาตั้งค่า Google Apps Script URL',
      'error'
    );

    return;
  }

  showToast(
    'กำลังเช็คข้อมูลนักศึกษาใน Google Sheet...',
    'info'
  );

  try {

    const response =
      await fetch(
        `${CONFIG.GOOGLE_SCRIPT_URL}?action=checkStudentId&studentId=${encodeURIComponent(studentId)}`
      );

    const result =
      await response.json();

    if (
      result &&
      result.status ===
        'success' &&
      result.exists
    ) {

      const userData = {

        studentId:
          studentId,

        name:
          result.name ||
          `นักศึกษา รหัส ${studentId}`,

        email:
          'direct_login',

        picture:
          ''
      };

      saveUserSession(
        userData
      );

      showMainApplication(
        userData
      );

      showToast(
        `ยินดีต้อนรับคุณ ${userData.name}!`,
        'success'
      );

    } else {

      showToast(
        `ไม่พบรหัสนักศึกษา ${studentId} ในฐานข้อมูล`,
        'error'
      );
    }

  } catch (err) {

    console.warn(
      'Direct login error:',
      err
    );

    showToast(
      'ไม่สามารถเชื่อมต่อ Google Sheet ได้',
      'error'
    );
  }
}

// ==========================================
// SAVE USER SESSION
// ==========================================

function saveUserSession(
  userData
) {

  if (!userData) {
    return;
  }

  if (userData.studentId) {
    userData.studentId =
      String(
        userData.studentId
      ).trim();
  }

  if (userData.lineUserId) {
    userData.lineUserId =
      String(
        userData.lineUserId
      ).trim();
  }

  if (userData.name) {
    userData.name =
      String(
        userData.name
      ).trim();
  }

  currentUser =
    userData;

  localStorage.setItem(
    'kmitl_pay_user',
    JSON.stringify(
      userData
    )
  );

  sessionStorage.removeItem(
    'kmitl_pay_manual_logout'
  );

  console.log(
    '[Session] Saved:',
    userData
  );
}

// ==========================================
// LOGOUT
// ==========================================

function logoutUser() {

  currentUser = null;

  localStorage.removeItem(
    'kmitl_pay_user'
  );

  sessionStorage.setItem(
    'kmitl_pay_manual_logout',
    '1'
  );

  try {

    if (
      typeof liff !== 'undefined' &&
      typeof liff.isLoggedIn ===
        'function' &&
      liff.isLoggedIn() &&
      typeof liff.logout ===
        'function'
    ) {

      liff.logout();
    }

  } catch (e) {

    console.warn(
      '[LIFF] Logout warning:',
      e
    );
  }

  showLoginScreen();

  showToast(
    'ออกจากระบบเรียบร้อยแล้ว',
    'info'
  );
}

// ==========================================
// MAIN APPLICATION
// ==========================================

function showMainApplication(
  user
) {

  if (!user) {
    return;
  }

  currentUser =
    user;

  const name =
    user.name ||
    `นักศึกษา รหัส ${user.studentId || ''}`;

  const displaySubtext =
    user.studentId ||
    user.email ||
    'KMITL Student';

  const userNameEl =
    document.getElementById(
      'userName'
    );

  if (userNameEl) {
    userNameEl.textContent =
      name;
  }

  const userEmailEl =
    document.getElementById(
      'userEmail'
    );

  if (userEmailEl) {
    userEmailEl.textContent =
      displaySubtext;
  }

  const userAvatarEl =
    document.getElementById(
      'userAvatar'
    );

  if (userAvatarEl) {

    userAvatarEl.textContent =
      name
        .trim()
        .charAt(0)
        .toUpperCase();
  }

  const welcomeStudentNameEl =
    document.getElementById(
      'welcomeStudentName'
    );

  if (
    welcomeStudentNameEl
  ) {

    welcomeStudentNameEl.textContent =
      name;
  }

  const loginSec =
    document.getElementById(
      'loginSection'
    );

  if (loginSec) {
    loginSec.style.display =
      'none';
  }

  const regSec =
    document.getElementById(
      'registerSection'
    );

  if (regSec) {
    regSec.style.display =
      'none';
  }

  const mainSec =
    document.getElementById(
      'mainAppSection'
    );

  if (mainSec) {
    mainSec.style.display =
      'block';
  }

  const navCtrl =
    document.getElementById(
      'navControls'
    );

  if (navCtrl) {
    navCtrl.style.display =
      'flex';
  }

  const navAdminLink =
    document.getElementById(
      'navAdminLink'
    );

  if (navAdminLink) {

    const adminIds = [
      '69010115',
      '69010165'
    ];

    if (
      user.studentId &&
      adminIds.includes(
        String(
          user.studentId
        ).trim()
      )
    ) {

      navAdminLink.style.display =
        'inline-flex';

    } else {

      navAdminLink.style.display =
        'none';
    }
  }

  renderStudentDashboard();
}

// ==========================================
// VIEW SWITCHER
// ==========================================

function switchView(
  view
) {

  currentView =
    view;

  const studentBtn =
    document.getElementById(
      'tabStudentBtn'
    );

  const adminBtn =
    document.getElementById(
      'tabAdminBtn'
    );

  const studentView =
    document.getElementById(
      'studentView'
    );

  const adminView =
    document.getElementById(
      'adminView'
    );

  if (
    view ===
    'student'
  ) {

    if (studentBtn)
      studentBtn.classList.add(
        'active'
      );

    if (adminBtn)
      adminBtn.classList.remove(
        'active'
      );

    if (studentView)
      studentView.style.display =
        'block';

    if (adminView)
      adminView.style.display =
        'none';

    renderStudentDashboard();

  } else {

    if (adminBtn)
      adminBtn.classList.add(
        'active'
      );

    if (studentBtn)
      studentBtn.classList.remove(
        'active'
      );

    if (studentView)
      studentView.style.display =
        'none';

    if (adminView)
      adminView.style.display =
        'block';

    renderAdminDashboard();
  }
}

// ==========================================
// CHECK PAYMENT BELONGS TO CURRENT USER
// ==========================================

function isSubmissionForCurrentUser(
  sub
) {

  if (
    !currentUser ||
    !sub
  ) {
    return false;
  }

  const currentStudentId =
    String(
      currentUser.studentId ||
      ''
    ).trim();

  const currentLineUserId =
    String(
      currentUser.lineUserId ||
      ''
    ).trim();

  const currentEmail =
    String(
      currentUser.email ||
      ''
    )
      .trim()
      .toLowerCase();

  const currentName =
    String(
      currentUser.name ||
      ''
    ).trim();

  const subStudentId =
    String(
      sub.studentId ||
      ''
    ).trim();

  const subLineUserId =
    String(
      sub.lineUserId ||
      ''
    ).trim();

  const subEmail =
    String(
      sub.studentEmail ||
      sub.email ||
      ''
    )
      .trim()
      .toLowerCase();

  const subName =
    String(
      sub.studentName ||
      ''
    ).trim();

  // PRIMARY: student ID
  if (
    currentStudentId &&
    subStudentId &&
    currentStudentId ===
      subStudentId
  ) {
    return true;
  }

  // SECONDARY: LINE User ID
  if (
    currentLineUserId &&
    subLineUserId &&
    currentLineUserId ===
      subLineUserId
  ) {
    return true;
  }

  // EMAIL
  if (
    currentEmail &&
    currentEmail !==
      'direct_login' &&
    subEmail &&
    currentEmail ===
      subEmail
  ) {
    return true;
  }

  // LAST FALLBACK: name
  if (
    currentName &&
    subName &&
    currentName ===
      subName
  ) {
    return true;
  }

  return false;
}

// ==========================================
// STUDENT DASHBOARD
// ==========================================

function renderStudentDashboard() {

  const grid =
    document.getElementById(
      'feeItemsGrid'
    );

  if (!grid) {
    return;
  }

  grid.innerHTML = '';

  if (!currentUser) {

    showLoginScreen();

    return;
  }

  const userSubsAll =
    submissions.filter(
      isSubmissionForCurrentUser
    );

  console.log(
    '[Dashboard] User:',
    currentUser
  );

  console.log(
    '[Dashboard] User payments:',
    userSubsAll
  );

  let unpaidTotal = 0;
  let paidTotal = 0;
  let pendingCount = 0;

  if (
    feeItems.length ===
    0
  ) {

    grid.innerHTML = `
      <div style="
        grid-column:1/-1;
        text-align:center;
        padding:3rem;
        color:var(--text-muted);
      ">
        ไม่มีรายการเก็บเงินในระบบขณะนี้
      </div>
    `;

    const statUnpaid =
      document.getElementById(
        'statUnpaid'
      );

    const statPaid =
      document.getElementById(
        'statPaid'
      );

    const statPending =
      document.getElementById(
        'statPending'
      );

    if (statUnpaid)
      statUnpaid.textContent =
        '฿0';

    if (statPaid)
      statPaid.textContent =
        '฿0';

    if (statPending)
      statPending.textContent =
        '0 รายการ';

    renderStudentHistoryTable();

    return;
  }

  feeItems.forEach(
    item => {

      const itemAmount =
        parseFloat(
          item.amount
        ) || 0;

      const relatedSubs =
        userSubsAll.filter(
          sub => {

            const sameFeeId =
              sub.feeId &&
              item.id &&
              String(
                sub.feeId
              ).trim() ===
              String(
                item.id
              ).trim();

            const sameFeeName =
              sub.feeName &&
              item.name &&
              String(
                sub.feeName
              ).trim() ===
              String(
                item.name
              ).trim();

            return (
              sameFeeId ||
              sameFeeName
            );
          }
        );

      const approvedSubs =
        relatedSubs.filter(
          sub =>
            normalizeStatus(
              sub.status
            ) ===
            'Approved'
        );

      const pendingSubs =
        relatedSubs.filter(
          sub =>
            normalizeStatus(
              sub.status
            ) ===
            'Pending'
        );

      const paidAmount =
        approvedSubs.reduce(
          (
            sum,
            sub
          ) =>
            sum +
            (
              parseFloat(
                sub.amount
              ) || 0
            ),
          0
        );

      const remaining =
        Math.max(
          0,
          itemAmount -
            paidAmount
        );

      paidTotal +=
        paidAmount;

      unpaidTotal +=
        remaining;

      pendingCount +=
        pendingSubs.length;

      let statusBadge =
        '';

      let paymentButton =
        '';

      // ====================================
      // FULLY PAID
      // ====================================

      if (
        paidAmount >=
        itemAmount
      ) {

        statusBadge = `
          <span class="fee-badge badge-paid">
            <i class="fa-solid fa-check"></i>
            ชำระแล้ว
          </span>
        `;

        paymentButton = `
          <button
            class="btn btn-secondary"
            style="
              width:100%;
              opacity:.7;
              cursor:not-allowed;
            "
            disabled
          >
            <i class="fa-solid fa-circle-check"></i>
            ชำระแล้ว
          </button>
        `;

      // ====================================
      // PENDING
      // ====================================

      } else if (
        pendingSubs.length >
        0
      ) {

        statusBadge = `
          <span class="fee-badge badge-pending">
            <i class="fa-solid fa-clock"></i>
            รอตรวจสอบ
          </span>
        `;

        paymentButton = `
          <button
            class="btn btn-secondary"
            style="
              width:100%;
              opacity:.7;
              cursor:not-allowed;
            "
            disabled
          >
            <i class="fa-solid fa-clock"></i>
            รอตรวจสอบ
          </button>
        `;

      // ====================================
      // NOT PAID
      // ====================================

      } else {

        statusBadge = `
          <span class="fee-badge badge-unpaid">
            <i class="fa-solid fa-circle-exclamation"></i>
            ยังไม่ได้จ่าย
          </span>
        `;

        paymentButton = `
          <button
            class="btn btn-primary"
            style="width:100%"
            onclick="openPaymentModal('${String(
              item.id
            ).replace(
              /'/g,
              "\\'"
            )}')"
          >
            <i class="fa-solid fa-qrcode"></i>
            ชำระเงิน / แนบสลิป
          </button>
        `;
      }

      const card =
        document.createElement(
          'div'
        );

      card.className =
        'glass-panel fee-card';

      card.innerHTML = `
        ${statusBadge}

        <div>

          <div class="fee-category">
            ${escapeHtml(
              item.category
            )}
          </div>

          <h4 class="fee-name">
            ${escapeHtml(
              item.name
            )}
          </h4>

          <p class="fee-description">
            ${escapeHtml(
              item.description
            )}
          </p>

        </div>

        <div>

          <div class="fee-meta">

            <div class="fee-amount">

              <span>
                จำนวนเงิน
              </span>

              <strong>
                ฿${itemAmount.toLocaleString()}
              </strong>

            </div>

            <div class="fee-due">

              <i class="fa-regular fa-calendar"></i>

              ครบกำหนด:
              ${escapeHtml(
                item.dueDate ||
                '-'
              )}

            </div>

          </div>

          ${paymentButton}

        </div>
      `;

      grid.appendChild(
        card
      );
    }
  );

  const statUnpaid =
    document.getElementById(
      'statUnpaid'
    );

  const statPaid =
    document.getElementById(
      'statPaid'
    );

  const statPending =
    document.getElementById(
      'statPending'
    );

  if (statUnpaid) {

    statUnpaid.textContent =
      `฿${unpaidTotal.toLocaleString()}`;
  }

  if (statPaid) {

    statPaid.textContent =
      `฿${paidTotal.toLocaleString()}`;
  }

  if (statPending) {

    statPending.textContent =
      `${pendingCount} รายการ`;
  }

  renderStudentHistoryTable();
}

// ==========================================
// STUDENT HISTORY
// ==========================================

function renderStudentHistoryTable() {

  const tbody =
    document.getElementById(
      'studentHistoryTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML = '';

  if (!currentUser) {
    return;
  }

  const userSubs =
    submissions.filter(
      isSubmissionForCurrentUser
    );

  if (
    userSubs.length ===
    0
  ) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="6"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:2rem;
          "
        >
          ยังไม่มีประวัติการส่งสลิปชำระเงิน
        </td>
      </tr>
    `;

    return;
  }

  userSubs.forEach(
    sub => {

      const normStatus =
        normalizeStatus(
          sub.status
        );

      let statusClass =
        'badge-unpaid';

      let statusText =
        'ไม่ผ่าน';

      if (
        normStatus ===
        'Approved'
      ) {

        statusClass =
          'badge-paid';

        statusText =
          'อนุมัติเรียบร้อย';

      } else if (
        normStatus ===
        'Pending'
      ) {

        statusClass =
          'badge-pending';

        statusText =
          'รอเหรัญญิกตรวจ';
      }

      const tr =
        document.createElement(
          'tr'
        );

      tr.innerHTML = `
        <td>
          ${escapeHtml(
            sub.timestamp ||
            '-'
          )}
        </td>

        <td>
          <strong>
            ${escapeHtml(
              sub.feeName ||
              '-'
            )}
          </strong>
        </td>

        <td>
          ฿${(
            parseFloat(
              sub.amount
            ) || 0
          ).toLocaleString()}
        </td>

        <td>

          <button
            class="btn btn-secondary btn-sm"
            onclick="viewAdminSlip('${String(
              sub.id
            ).replace(
              /'/g,
              "\\'"
            )}')"
          >
            <i class="fa-solid fa-image"></i>
            ดูสลิป
          </button>

        </td>

        <td>

          <span class="fee-badge ${statusClass}">
            ${statusText}
          </span>

        </td>

        <td>

          <a
            href="${sub.slipUrl || '#'}"
            target="_blank"
            class="btn btn-secondary btn-sm"
          >
            <i class="fa-solid fa-external-link"></i>
            เปิด Drive
          </a>

        </td>
      `;

      tbody.appendChild(
        tr
      );
    }
  );
}

// ==========================================
// PROMPTPAY
// ==========================================

function generatePromptPayQRPayload(
  target,
  amount
) {

  const sanitize =
    target.replace(
      /[^0-9]/g,
      ''
    );

  let targetType =
    '01';

  let formattedTarget =
    sanitize;

  if (
    sanitize.length ===
    10
  ) {

    formattedTarget =
      '0066' +
      sanitize.substring(1);

    targetType =
      '01';

  } else if (
    sanitize.length ===
    13
  ) {

    targetType =
      '02';
  }

  const amountStr =
    amount
      ? amount.toFixed(2)
      : '0.00';

  const amountLen =
    ('0' +
      amountStr.length
    ).slice(-2);

  let payload =
    `00020101021129370016A000000677010111${targetType}${('0' + formattedTarget.length).slice(-2)}${formattedTarget}5802TH5303764${
      amount
        ? '54' +
          amountLen +
          amountStr
        : ''
    }6304`;

  const crc =
    crc16(payload);

  return (
    payload +
    crc
  );
}

function crc16(
  data
) {

  let crc =
    0xFFFF;

  for (
    let i = 0;
    i < data.length;
    i++
  ) {

    let x =
      (
        (crc >> 8) ^
        data.charCodeAt(i)
      ) &
      0xFF;

    x ^=
      x >> 4;

    crc =
      (
        (crc << 8) ^
        (x << 12) ^
        (x << 5) ^
        x
      ) &
      0xFFFF;
  }

  return (
    '0000' +
    crc
      .toString(16)
      .toUpperCase()
  ).slice(-4);
}

// ==========================================
// PAYMENT MODAL
// ==========================================

function openPaymentModal(
  feeId
) {

  selectedFeeItem =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (!selectedFeeItem) {
    return;
  }

  // ========================================
  // EXTRA SAFETY:
  // CHECK CURRENT USER PAYMENT STATUS
  // ========================================

  const userSubs =
    submissions.filter(
      isSubmissionForCurrentUser
    );

  const relatedSubs =
    userSubs.filter(
      sub =>
        (
          sub.feeId &&
          String(
            sub.feeId
          ) ===
          String(
            selectedFeeItem.id
          )
        ) ||
        (
          sub.feeName &&
          String(
            sub.feeName
          ).trim() ===
          String(
            selectedFeeItem.name
          ).trim()
        )
    );

  const approved =
    relatedSubs.filter(
      sub =>
        normalizeStatus(
          sub.status
        ) ===
        'Approved'
    );

  const pending =
    relatedSubs.filter(
      sub =>
        normalizeStatus(
          sub.status
        ) ===
        'Pending'
    );

  const paidAmount =
    approved.reduce(
      (
        sum,
        sub
      ) =>
        sum +
        (
          parseFloat(
            sub.amount
          ) || 0
        ),
      0
    );

  if (
    paidAmount >=
    Number(
      selectedFeeItem.amount
    )
  ) {

    showToast(
      'รายการนี้ชำระแล้ว',
      'info'
    );

    renderStudentDashboard();

    return;
  }

  if (
    pending.length >
    0
  ) {

    showToast(
      'รายการนี้มีสลิปที่กำลังรอตรวจสอบอยู่',
      'info'
    );

    renderStudentDashboard();

    return;
  }

  currentPaymentQty =
    1;

  const modalTitle =
    document.getElementById(
      'modalFeeTitle'
    );

  if (modalTitle) {

    modalTitle.textContent =
      `ชำระเงิน: ${selectedFeeItem.name}`;
  }

  const receiver =
    document.getElementById(
      'modalPromptPayReceiver'
    );

  if (receiver) {

    receiver.textContent =
      `ชื่อบัญชี: ${CONFIG.PROMPTPAY_NAME} (PromptPay: ${maskPromptPay(CONFIG.PROMPTPAY_NUMBER)})`;
  }

  resetSlipUploader();

  updatePaymentQR();

  const modal =
    document.getElementById(
      'paymentModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

function changePaymentQty(
  delta
) {

  const newQty =
    currentPaymentQty +
    delta;

  if (
    newQty < 1 ||
    newQty > 10
  ) {
    return;
  }

  currentPaymentQty =
    newQty;

  updatePaymentQR();
}

function updatePaymentQR() {

  if (!selectedFeeItem) {
    return;
  }

  const unitPrice =
    Number(
      selectedFeeItem.amount
    ) || 0;

  const totalAmount =
    unitPrice *
    currentPaymentQty;

  const qtyValue =
    document.getElementById(
      'qtyValue'
    );

  if (qtyValue) {
    qtyValue.textContent =
      currentPaymentQty;
  }

  const qtyMinus =
    document.getElementById(
      'qtyMinus'
    );

  if (qtyMinus) {
    qtyMinus.disabled =
      currentPaymentQty <=
      1;
  }

  const qtyPlus =
    document.getElementById(
      'qtyPlus'
    );

  if (qtyPlus) {
    qtyPlus.disabled =
      currentPaymentQty >=
      10;
  }

  const qtySummaryText =
    document.getElementById(
      'qtySummaryText'
    );

  if (qtySummaryText) {

    qtySummaryText.textContent =
      `฿${unitPrice.toLocaleString(
        undefined,
        {
          minimumFractionDigits:
            2
        }
      )} × ${currentPaymentQty} = `;
  }

  const qtySummaryTotal =
    document.getElementById(
      'qtySummaryTotal'
    );

  if (qtySummaryTotal) {

    qtySummaryTotal.textContent =
      `฿${totalAmount.toLocaleString(
        undefined,
        {
          minimumFractionDigits:
            2
        }
      )}`;
  }

  const amountEl =
    document.getElementById(
      'modalPromptPayAmount'
    );

  if (amountEl) {

    amountEl.textContent =
      `฿${totalAmount.toFixed(2)}`;
  }

  const payload =
    generatePromptPayQRPayload(
      CONFIG.PROMPTPAY_NUMBER,
      totalAmount
    );

  const qrImg =
    document.getElementById(
      'qrImg'
    );

  if (qrImg) {

    qrImg.src =
      `https://api.qrserver.com/v1/create-qr-code/?size=220x220&data=${encodeURIComponent(payload)}`;

    qrImg.style.display =
      'block';
  }

  const qrCanvas =
    document.getElementById(
      'qrCanvas'
    );

  if (
    typeof QRCode !==
      'undefined' &&
    qrCanvas
  ) {

    QRCode.toCanvas(
      qrCanvas,
      payload,
      {
        width:
          220,

        margin:
          2
      },
      error => {

        if (!error) {

          qrCanvas.style.display =
            'block';

          if (qrImg) {
            qrImg.style.display =
              'none';
          }
        }
      }
    );
  }
}

function closeModal(
  modalId
) {

  const modal =
    document.getElementById(
      modalId
    );

  if (modal) {
    modal.classList.remove(
      'active'
    );
  }
}

// ==========================================
// DRAG & DROP
// ==========================================

function setupDragAndDrop() {

  const dropzone =
    document.getElementById(
      'slipDropzone'
    );

  if (!dropzone) {
    return;
  }

  [
    'dragenter',
    'dragover'
  ].forEach(
    eventName => {

      dropzone.addEventListener(
        eventName,
        e => {

          e.preventDefault();

          dropzone.classList.add(
            'dragover'
          );
        },
        false
      );
    }
  );

  [
    'dragleave',
    'drop'
  ].forEach(
    eventName => {

      dropzone.addEventListener(
        eventName,
        e => {

          e.preventDefault();

          dropzone.classList.remove(
            'dragover'
          );
        },
        false
      );
    }
  );

  dropzone.addEventListener(
    'drop',
    e => {

      const files =
        e.dataTransfer.files;

      if (
        files &&
        files.length >
          0
      ) {

        processSelectedSlip(
          files[0]
        );
      }
    }
  );
}

function handleFileSelect(
  e
) {

  const files =
    e.target.files;

  if (
    files &&
    files.length >
      0
  ) {

    processSelectedSlip(
      files[0]
    );
  }
}

// ==========================================
// SLIP PROCESSING
// ==========================================

function processSelectedSlip(
  file
) {

  if (
    !file ||
    !file.type.startsWith(
      'image/'
    )
  ) {

    showToast(
      'กรุณาเลือกไฟล์รูปภาพสลิปเท่านั้น',
      'error'
    );

    return;
  }

  const reader =
    new FileReader();

  reader.onload =
    function (
      evt
    ) {

      const previewBox =
        document.getElementById(
          'slipPreviewBox'
        );

      const previewImg =
        document.getElementById(
          'slipPreviewImg'
        );

      const scanStatus =
        document.getElementById(
          'slipScanResult'
        );

      if (scanStatus) {

        scanStatus.innerHTML =
          `
          <i class="fa-solid fa-spinner fa-spin"></i>
          กำลังประมวลผลและบีบอัดรูปภาพสลิป...
          `;
      }

      const img =
        new Image();

      img.onload =
        function () {

          try {

            const canvas =
              document.createElement(
                'canvas'
              );

            let w =
              img.width;

            let h =
              img.height;

            const MAX_DIM =
              1200;

            if (
              w >
                MAX_DIM ||
              h >
                MAX_DIM
            ) {

              if (
                w >
                h
              ) {

                h =
                  Math.round(
                    (
                      h *
                      MAX_DIM
                    ) /
                    w
                  );

                w =
                  MAX_DIM;

              } else {

                w =
                  Math.round(
                    (
                      w *
                      MAX_DIM
                    ) /
                    h
                  );

                h =
                  MAX_DIM;
              }
            }

            canvas.width =
              w;

            canvas.height =
              h;

            const ctx =
              canvas.getContext(
                '2d'
              );

            ctx.drawImage(
              img,
              0,
              0,
              w,
              h
            );

            currentSlipBase64 =
              canvas.toDataURL(
                'image/jpeg',
                0.82
              );

            if (previewImg) {
              previewImg.src =
                currentSlipBase64;
            }

            if (previewBox) {
              previewBox.style.display =
                'block';
            }

            if (
              typeof jsQR !==
              'undefined'
            ) {

              const imageData =
                ctx.getImageData(
                  0,
                  0,
                  w,
                  h
                );

              const code =
                jsQR(
                  imageData.data,
                  imageData.width,
                  imageData.height,
                  {
                    inversionAttempts:
                      'dontInvert'
                  }
                );

              if (code) {

                currentSlipQRData =
                  code.data;

                if (scanStatus) {

                  scanStatus.innerHTML =
                    `
                    <i
                      class="fa-solid fa-circle-check"
                      style="color:var(--color-success)"
                    ></i>
                    <span>
                      ตรวจพบ QR Code บนสลิปเรียบร้อย
                    </span>
                    `;
                }

                showToast(
                  'สแกน QR Code บนสลิปเรียบร้อย',
                  'success'
                );

                return;
              }
            }

          } catch (err) {

            console.warn(
              'QR scanner / compression error:',
              err
            );

            currentSlipBase64 =
              evt.target.result;

            if (previewImg) {
              previewImg.src =
                currentSlipBase64;
            }

            if (previewBox) {
              previewBox.style.display =
                'block';
            }
          }

          currentSlipQRData =
            null;

          if (scanStatus) {

            scanStatus.innerHTML =
              `
              <i
                class="fa-solid fa-circle-check"
                style="color:var(--color-success)"
              ></i>
              รูปภาพสลิปพร้อมส่งแล้ว
              `;
          }

          showToast(
            'รูปสลิปพร้อมส่งแล้ว',
            'success'
          );
        };

      img.onerror =
        function () {

          currentSlipBase64 =
            evt.target.result;

          if (previewImg) {
            previewImg.src =
              currentSlipBase64;
          }

          if (previewBox) {
            previewBox.style.display =
              'block';
          }

          if (scanStatus) {
            scanStatus.innerHTML =
              'รูปภาพสลิปพร้อมส่งแล้ว';
          }
        };

      img.src =
        evt.target.result;
    };

  reader.onerror =
    function () {

      showToast(
        'เกิดข้อผิดพลาดในการอ่านไฟล์รูปภาพ',
        'error'
      );
    };

  reader.readAsDataURL(
    file
  );
}

// ==========================================
// RESET SLIP
// ==========================================

function resetSlipUploader() {

  currentSlipBase64 =
    null;

  currentSlipQRData =
    null;

  const slipInput =
    document.getElementById(
      'slipInput'
    );

  if (slipInput) {
    slipInput.value =
      '';
  }

  const previewBox =
    document.getElementById(
      'slipPreviewBox'
    );

  if (previewBox) {
    previewBox.style.display =
      'none';
  }

  const remark =
    document.getElementById(
      'paymentRemark'
    );

  if (remark) {
    remark.value =
      '';
  }
}

// ==========================================
// SUBMIT PAYMENT
// ==========================================

async function handlePaymentSubmit(
  e
) {

  e.preventDefault();

  if (!currentUser) {

    showToast(
      'กรุณาเข้าสู่ระบบก่อนชำระเงิน',
      'error'
    );

    return;
  }

  if (!selectedFeeItem) {

    showToast(
      'ไม่พบรายการชำระเงิน',
      'error'
    );

    return;
  }

  if (!currentSlipBase64) {

    showToast(
      'กรุณาเลือกรูปภาพสลิปก่อนส่ง',
      'info'
    );

    const slipInput =
      document.getElementById(
        'slipInput'
      );

    if (slipInput) {
      slipInput.click();
    }

    return;
  }

  // ========================================
  // FINAL SAFETY CHECK
  // ========================================

  const userSubs =
    submissions.filter(
      isSubmissionForCurrentUser
    );

  const relatedSubs =
    userSubs.filter(
      sub =>
        (
          sub.feeId &&
          String(
            sub.feeId
          ) ===
          String(
            selectedFeeItem.id
          )
        ) ||
        (
          sub.feeName &&
          String(
            sub.feeName
          ).trim() ===
          String(
            selectedFeeItem.name
          ).trim()
        )
    );

  const approved =
    relatedSubs.filter(
      sub =>
        normalizeStatus(
          sub.status
        ) ===
        'Approved'
    );

  const pending =
    relatedSubs.filter(
      sub =>
        normalizeStatus(
          sub.status
        ) ===
        'Pending'
    );

  const paidAmount =
    approved.reduce(
      (
        sum,
        sub
      ) =>
        sum +
        (
          parseFloat(
            sub.amount
          ) || 0
        ),
      0
    );

  if (
    paidAmount >=
    Number(
      selectedFeeItem.amount
    )
  ) {

    showToast(
      'รายการนี้ชำระแล้ว',
      'info'
    );

    closeModal(
      'paymentModal'
    );

    return;
  }

  if (
    pending.length >
    0
  ) {

    showToast(
      'รายการนี้มีสลิปกำลังรอตรวจสอบ',
      'info'
    );

    closeModal(
      'paymentModal'
    );

    return;
  }

  const submitBtn =
    document.getElementById(
      'btnSubmitPayment'
    );

  if (!submitBtn) {
    return;
  }

  submitBtn.disabled =
    true;

  submitBtn.innerHTML =
    `
    <i class="fa-solid fa-spinner fa-spin"></i>
    กำลังบันทึกลง Google Drive & Sheet...
    `;

  const studentName =
    currentUser.name ||
    'นักศึกษา KMITL';

  const studentId =
    String(
      currentUser.studentId ||
      ''
    ).trim();

  const lineUserId =
    String(
      currentUser.lineUserId ||
      ''
    ).trim();

  if (!studentId) {

    submitBtn.disabled =
      false;

    showToast(
      'ไม่พบรหัสนักศึกษาใน Session',
      'error'
    );

    return;
  }

  const remarkEl =
    document.getElementById(
      'paymentRemark'
    );

  const newSubmission = {

    id:
      'sub-' +
      Date.now(),

    studentName:
      studentName,

    studentId:
      studentId,

    lineUserId:
      lineUserId,

    studentEmail:
      studentId,

    feeId:
      selectedFeeItem.id,

    feeName:
      selectedFeeItem.name,

    amount:
      Number(
        selectedFeeItem.amount
      ) *
      currentPaymentQty,

    status:
      'Pending',

    timestamp:
      new Date().toLocaleString(
        'th-TH'
      ),

    slipUrl:
      '',

    slipBase64:
      currentSlipBase64,

    qrRef:
      currentSlipQRData || '',

    remark:
      remarkEl
        ? remarkEl.value ||
          '-'
        : '-'
  };

  if (!CONFIG.GOOGLE_SCRIPT_URL) {

    submitBtn.disabled =
      false;

    submitBtn.innerHTML =
      `
      <i class="fa-solid fa-paper-plane"></i>
      ยืนยันการส่งสลิป
      `;

    showToast(
      'ยังไม่ได้ตั้งค่า Google Apps Script URL',
      'error'
    );

    return;
  }

  try {

    newSubmission.action =
      'submitPayment';

    await postToGasReliable(
      newSubmission
    );

    showToast(
      'ส่งสลิปชำระเงินเรียบร้อย! กำลังรอตรวจสอบ 🟢',
      'success'
    );

    closeModal(
      'paymentModal'
    );

    resetSlipUploader();

    // ========================================
    // IMPORTANT:
    // DO NOT:
    //
    // submissions.unshift(newSubmission)
    //
    // Google Sheet is source of truth.
    // ========================================

    setTimeout(
      async () => {

        await fetchSubmissionsFromGas();

        if (currentUser) {
          renderStudentDashboard();
        }

      },
      2500
    );

  } catch (err) {

    console.error(
      'Payment submit error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการส่งข้อมูล: ' +
      err.message,
      'error'
    );

  } finally {

    submitBtn.disabled =
      false;

    submitBtn.innerHTML =
      `
      <i class="fa-solid fa-paper-plane"></i>
      ยืนยันการส่งสลิป
      `;
  }
}

// ==========================================
// ADMIN DASHBOARD
// ==========================================

function renderAdminDashboard() {

  renderAdminFeeItemsTable();

  renderAdminSubmissionsTable();
}

function renderAdminFeeItemsTable() {

  const tbody =
    document.getElementById(
      'adminFeeItemsTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML =
    '';

  if (
    feeItems.length ===
    0
  ) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="5"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:1.5rem;
          "
        >
          ยังไม่มีรายการเก็บเงินที่สร้างไว้
        </td>
      </tr>
    `;

    return;
  }

  feeItems.forEach(
    item => {

      const tr =
        document.createElement(
          'tr'
        );

      tr.innerHTML = `
        <td>
          <strong>
            ${escapeHtml(
              item.name
            )}
          </strong>
        </td>

        <td>
          <span
            style="
              font-size:.8rem;
              color:var(--kmitl-orange);
            "
          >
            ${escapeHtml(
              item.category
            )}
          </span>
        </td>

        <td>
          <strong
            style="
              color:var(--kmitl-gold);
            "
          >
            ฿${(
              Number(
                item.amount
              ) || 0
            ).toLocaleString()}
          </strong>
        </td>

        <td>
          ${escapeHtml(
            item.dueDate ||
            '-'
          )}
        </td>

        <td>

          <div
            style="
              display:flex;
              gap:6px;
            "
          >

            <button
              class="btn btn-success btn-sm"
              onclick="syncFeeItemToSheet('${String(
                item.id
              ).replace(
                /'/g,
                "\\'"
              )}')"
            >
              <i class="fa-solid fa-cloud-arrow-up"></i>
              ส่งไปชีท
            </button>

            <button
              class="btn btn-danger btn-sm"
              onclick="deleteFeeItem('${String(
                item.id
              ).replace(
                /'/g,
                "\\'"
              )}')"
            >
              <i class="fa-solid fa-trash"></i>
              ลบรายการ
            </button>

          </div>

        </td>
      `;

      tbody.appendChild(
        tr
      );
    }
  );
}

// ==========================================
// ADMIN PAYMENT TABLE
// ==========================================

function renderAdminSubmissionsTable() {

  const tbody =
    document.getElementById(
      'adminSubmissionsTable'
    );

  if (!tbody) {
    return;
  }

  tbody.innerHTML =
    '';

  if (
    submissions.length ===
    0
  ) {

    tbody.innerHTML = `
      <tr>
        <td
          colspan="7"
          style="
            text-align:center;
            color:var(--text-muted);
            padding:2rem;
          "
        >
          ยังไม่มีรายการส่งสลิปชำระเงินในระบบ
        </td>
      </tr>
    `;

    return;
  }

  submissions.forEach(
    sub => {

      const normStatus =
        normalizeStatus(
          sub.status
        );

      let statusClass =
        'badge-pending';

      let statusText =
        'รอตรวจสอบ';

      if (
        normStatus ===
        'Approved'
      ) {

        statusClass =
          'badge-paid';

        statusText =
          'อนุมัติแล้ว';

      } else if (
        normStatus ===
        'Rejected'
      ) {

        statusClass =
          'badge-unpaid';

        statusText =
          'ปฏิเสธแล้ว';
      }

      const isApproved =
        normStatus ===
        'Approved';

      const isRejected =
        normStatus ===
        'Rejected';

      const tr =
        document.createElement(
          'tr'
        );

      tr.innerHTML = `
        <td>
          ${escapeHtml(
            sub.timestamp ||
            '-'
          )}
        </td>

        <td>

          <div
            style="font-weight:600"
          >
            ${escapeHtml(
              sub.studentName ||
              '-'
            )}
          </div>

          <div
            style="
              font-size:.775rem;
              color:var(--text-secondary);
            "
          >
            รหัส:
            ${escapeHtml(
              sub.studentId ||
              sub.studentEmail ||
              '-'
            )}
          </div>

        </td>

        <td>
          ${escapeHtml(
            sub.feeName ||
            '-'
          )}
        </td>

        <td>

          <strong
            style="
              color:var(--kmitl-gold);
            "
          >
            ฿${(
              Number(
                sub.amount
              ) || 0
            ).toLocaleString()}
          </strong>

        </td>

        <td>

          <button
            class="btn btn-secondary btn-sm"
            onclick="viewAdminSlip('${String(
              sub.id
            ).replace(
              /'/g,
              "\\'"
            )}')"
          >
            <i class="fa-solid fa-image"></i>
            ดูสลิป
            ${
              sub.qrRef
                ? '(สแกนแล้ว)'
                : ''
            }
          </button>

        </td>

        <td>

          <span
            class="fee-badge ${statusClass}"
          >
            ${statusText}
          </span>

        </td>

        <td>

          <div
            style="
              display:flex;
              gap:6px;
            "
          >

            <button
              class="btn btn-success btn-sm"
              onclick="updateStatus('${String(
                sub.id
              ).replace(
                /'/g,
                "\\'"
              )}', 'Approved')"
              ${isApproved ? 'disabled' : ''}
            >
              <i class="fa-solid fa-check"></i>
              ${
                isApproved
                  ? 'อนุมัติแล้ว'
                  : 'อนุมัติ'
              }
            </button>

            <button
              class="btn btn-danger btn-sm"
              onclick="updateStatus('${String(
                sub.id
              ).replace(
                /'/g,
                "\\'"
              )}', 'Rejected')"
              ${isRejected ? 'disabled' : ''}
            >
              <i class="fa-solid fa-xmark"></i>
              ${
                isRejected
                  ? 'ปฏิเสธแล้ว'
                  : 'ไม่อนุมัติ'
              }
            </button>

          </div>

        </td>
      `;

      tbody.appendChild(
        tr
      );
    }
  );
}

// ==========================================
// VIEW SLIP
// ==========================================

function viewAdminSlip(
  subId
) {

  const sub =
    submissions.find(
      s =>
        String(s.id) ===
        String(subId)
    );

  if (!sub) {
    return;
  }

  const fullImg =
    document.getElementById(
      'adminSlipFullImg'
    );

  const metaBox =
    document.getElementById(
      'adminSlipMeta'
    );

  const driveBtn =
    document.getElementById(
      'adminDriveLinkBtn'
    );

  if (fullImg) {

    fullImg.src =
      sub.slipBase64 ||
      'https://via.placeholder.com/400x500?text=Slip+Image';
  }

  if (metaBox) {

    metaBox.innerHTML = `
      <div>
        <strong>ชื่อผู้โอน:</strong>
        ${escapeHtml(
          sub.studentName ||
          '-'
        )}
      </div>

      <div>
        <strong>รหัสนักศึกษา:</strong>
        ${escapeHtml(
          sub.studentId ||
          sub.studentEmail ||
          '-'
        )}
      </div>

      <div>
        <strong>รายการ:</strong>
        ${escapeHtml(
          sub.feeName ||
          '-'
        )}
      </div>

      <div>
        <strong>จำนวนเงิน:</strong>
        ฿${(
          Number(
            sub.amount
          ) || 0
        ).toLocaleString()}
      </div>

      <div>
        <strong>เวลาส่ง:</strong>
        ${escapeHtml(
          sub.timestamp ||
          '-'
        )}
      </div>

      ${
        sub.qrRef
          ? `
            <div
              style="
                margin-top:6px;
                color:#60a5fa;
              "
            >
              <strong>
                QR Payload Scan:
              </strong>

              ${escapeHtml(
                sub.qrRef
              )}
            </div>
          `
          : ''
      }

      ${
        sub.remark
          ? `
            <div>
              <strong>
                หมายเหตุ:
              </strong>

              ${escapeHtml(
                sub.remark
              )}
            </div>
          `
          : ''
      }
    `;
  }

  if (driveBtn) {

    driveBtn.href =
      sub.slipUrl ||
      '#';
  }

  const modal =
    document.getElementById(
      'viewSlipModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

// ==========================================
// UPDATE PAYMENT STATUS
// ==========================================

async function updateStatus(
  subId,
  newStatus
) {

  const sub =
    submissions.find(
      s =>
        String(s.id) ===
        String(subId)
    );

  if (!sub) {
    return;
  }

  if (
    !CONFIG.GOOGLE_SCRIPT_URL
  ) {

    showToast(
      'ยังไม่ได้ตั้งค่า Google Apps Script',
      'error'
    );

    return;
  }

  const oldStatus =
    sub.status;

  // ========================================
  // LOCAL UI ONLY
  // ========================================

  sub.status =
    newStatus;

  renderAdminDashboard();

  showToast(
    `กำลังอัปเดตสถานะเป็น ${
      newStatus ===
      'Approved'
        ? 'อนุมัติ'
        : 'ปฏิเสธ'
    }...`,
    'info'
  );

  try {

    let rowNumber =
      sub.rowNumber ||
      '';

    // ถ้า GAS ส่ง rowNumber มา ใช้ตัวนั้น
    // ถ้าไม่มี ค่อย fallback
    if (!rowNumber) {

      const index =
        submissions.indexOf(
          sub
        );

      if (
        index >= 0
      ) {

        rowNumber =
          index + 2;
      }
    }

    await postToGasReliable({

      action:
        'updatePaymentStatus',

      studentId:
        sub.studentId ||
        sub.studentEmail ||
        '',

      studentName:
        sub.studentName ||
        '',

      feeName:
        sub.feeName ||
        '',

      status:
        newStatus,

      amount:
        sub.amount ||
        0,

      rowNumber:
        rowNumber
    });

    showToast(
      'ส่งคำสั่งอัปเดต Google Sheet แล้ว 🟢',
      'success'
    );

    // ========================================
    // GET FRESH DATA
    // ========================================

    setTimeout(
      async () => {

        await fetchSubmissionsFromGas();

        renderAdminDashboard();

        if (currentUser) {
          renderStudentDashboard();
        }

      },
      2500
    );

  } catch (err) {

    console.error(
      'Update status error:',
      err
    );

    // rollback
    sub.status =
      oldStatus;

    renderAdminDashboard();

    showToast(
      'อัปเดตสถานะไม่สำเร็จ: ' +
      err.message,
      'error'
    );
  }
}

// ==========================================
// SYNC ALL ADMIN DATA
// ==========================================

async function syncAllAdminData() {

  const btn =
    document.getElementById(
      'btnSyncAllData'
    );

  if (btn) {

    btn.disabled =
      true;

    btn.innerHTML =
      `
      <i class="fa-solid fa-spinner fa-spin"></i>
      กำลังซิงก์ข้อมูล...
      `;
  }

  showToast(
    'กำลังซิงก์ข้อมูลกับ Google Sheet...',
    'info'
  );

  try {

    await fetchSubmissionsFromGas();

    await fetchFeeItemsFromGas();

    showToast(
      'ซิงก์ข้อมูลสำเร็จแล้ว 🟢',
      'success'
    );

  } catch (err) {

    console.warn(
      'Sync all error:',
      err
    );

    showToast(
      'เกิดข้อผิดพลาดในการซิงก์ข้อมูล',
      'error'
    );

  } finally {

    if (btn) {

      btn.disabled =
        false;

      btn.innerHTML =
        `
        <i class="fa-solid fa-floppy-disk"></i>
        บันทึก & ซิงก์ข้อมูล Google Sheet
        `;
    }
  }
}

// ==========================================
// CREATE FEE
// ==========================================

function openCreateFeeModal() {

  const modal =
    document.getElementById(
      'createFeeModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

async function handleCreateFeeSubmit(
  e
) {

  e.preventDefault();

  const category =
    document.getElementById(
      'newFeeCategory'
    )?.value || '';

  const name =
    document.getElementById(
      'newFeeName'
    )?.value || '';

  const desc =
    document.getElementById(
      'newFeeDesc'
    )?.value || '';

  const amount =
    parseFloat(
      document.getElementById(
        'newFeeAmount'
      )?.value
    ) || 0;

  const dueDate =
    document.getElementById(
      'newFeeDueDate'
    )?.value ||
    '2026-08-31';

  const newFee = {

    id:
      'fee-' +
      Date.now(),

    category:
      category,

    name:
      name,

    description:
      desc,

    amount:
      amount,

    dueDate:
      dueDate
  };

  feeItems.push(
    newFee
  );

  saveFeeItemsToStorage();

  closeModal(
    'createFeeModal'
  );

  const fields = [
    'newFeeCategory',
    'newFeeName',
    'newFeeDesc',
    'newFeeAmount'
  ];

  fields.forEach(
    id => {

      const el =
        document.getElementById(
          id
        );

      if (el) {
        el.value =
          '';
      }
    }
  );

  renderStudentDashboard();
  renderAdminDashboard();

  showToast(
    'เพิ่มรายการเก็บเงินแล้ว',
    'success'
  );

  if (
    CONFIG.GOOGLE_SCRIPT_URL
  ) {

    try {

      await postToGasReliable({
        action:
          'saveFeeItem',

        feeItem:
          newFee
      });

      showToast(
        'ซิงก์รายการลง Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        'Sync fee item error:',
        err
      );
    }
  }
}

// ==========================================
// DELETE FEE
// ==========================================

async function deleteFeeItem(
  feeId
) {

  const itemToDelete =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (
    !confirm(
      'คุณต้องการลบรายการเก็บเงินนี้ใช่หรือไม่?'
    )
  ) {
    return;
  }

  feeItems =
    feeItems.filter(
      f =>
        String(f.id) !==
        String(feeId)
    );

  saveFeeItemsToStorage();

  renderAdminDashboard();
  renderStudentDashboard();

  showToast(
    'ลบรายการเก็บเงินเรียบร้อยแล้ว',
    'info'
  );

  if (
    CONFIG.GOOGLE_SCRIPT_URL
  ) {

    try {

      await postToGasReliable({

        action:
          'deleteFeeItem',

        feeId:
          feeId,

        feeName:
          itemToDelete
            ? itemToDelete.name
            : ''
      });

      showToast(
        'ลบรายการออกจาก Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        'Delete fee item error:',
        err
      );
    }
  }
}

// ==========================================
// SYNC FEE ITEM
// ==========================================

async function syncFeeItemToSheet(
  feeId
) {

  const item =
    feeItems.find(
      f =>
        String(f.id) ===
        String(feeId)
    );

  if (!item) {
    return;
  }

  if (
    !CONFIG.GOOGLE_SCRIPT_URL
  ) {

    showToast(
      'กรุณาตั้งค่า Google Apps Script URL',
      'error'
    );

    return;
  }

  showToast(
    'กำลังส่งรายการไป Google Sheet...',
    'info'
  );

  try {

    await postToGasReliable({

      action:
        'deleteFeeItem',

      feeId:
        feeId,

      feeName:
        item.name
    });

  } catch (e) {

    console.warn(
      'Pre-delete warning:',
      e
    );
  }

  try {

    await postToGasReliable({

      action:
        'saveFeeItem',

      feeItem:
        item
    });

    showToast(
      'ส่งรายการไป Google Sheet สำเร็จ 🟢',
      'success'
    );

  } catch (err) {

    console.warn(
      'Sync fee item error:',
      err
    );

    showToast(
      'ส่งข้อมูลไป Google Sheet ไม่สำเร็จ',
      'error'
    );
  }
}

// ==========================================
// CONFIGURATION
// ==========================================

function openConfigModal() {

  const scriptUrl =
    document.getElementById(
      'cfgScriptUrl'
    );

  const lineId =
    document.getElementById(
      'cfgLineChannelId'
    );

  const lineSecret =
    document.getElementById(
      'cfgLineChannelSecret'
    );

  const promptPay =
    document.getElementById(
      'cfgPromptPay'
    );

  const promptPayName =
    document.getElementById(
      'cfgPromptPayName'
    );

  if (scriptUrl)
    scriptUrl.value =
      CONFIG.GOOGLE_SCRIPT_URL ||
      '';

  if (lineId)
    lineId.value =
      CONFIG.LINE_CHANNEL_ID ||
      '';

  if (lineSecret)
    lineSecret.value =
      CONFIG.LINE_CHANNEL_SECRET ||
      '';

  if (promptPay)
    promptPay.value =
      CONFIG.PROMPTPAY_NUMBER ||
      '';

  if (promptPayName)
    promptPayName.value =
      CONFIG.PROMPTPAY_NAME ||
      '';

  const modal =
    document.getElementById(
      'configModal'
    );

  if (modal) {
    modal.classList.add(
      'active'
    );
  }
}

async function handleSaveConfig(
  e
) {

  e.preventDefault();

  CONFIG.GOOGLE_SCRIPT_URL =
    document.getElementById(
      'cfgScriptUrl'
    )?.value.trim() ||
    '';

  CONFIG.LINE_CHANNEL_ID =
    document.getElementById(
      'cfgLineChannelId'
    )?.value.trim() ||
    '';

  CONFIG.LINE_CHANNEL_SECRET =
    document.getElementById(
      'cfgLineChannelSecret'
    )?.value.trim() ||
    '';

  CONFIG.PROMPTPAY_NUMBER =
    document.getElementById(
      'cfgPromptPay'
    )?.value.trim() ||
    '';

  CONFIG.PROMPTPAY_NAME =
    document.getElementById(
      'cfgPromptPayName'
    )?.value.trim() ||
    '';

  saveConfigToStorage();

  closeModal(
    'configModal'
  );

  showToast(
    'บันทึกการตั้งค่าเรียบร้อยแล้ว',
    'success'
  );

  if (
    CONFIG.GOOGLE_SCRIPT_URL
  ) {

    try {

      await postToGasReliable({

        action:
          'saveSystemConfig',

        settings: {

          PROMPTPAY_NUMBER:
            CONFIG.PROMPTPAY_NUMBER,

          PROMPTPAY_NAME:
            CONFIG.PROMPTPAY_NAME
        }
      });

      showToast(
        'ซิงก์การตั้งค่าลง Google Sheet แล้ว 🟢',
        'success'
      );

    } catch (err) {

      console.warn(
        'Sync config error:',
        err
      );
    }
  }
}

// ==========================================
// FETCH SYSTEM CONFIG
// ==========================================

async function fetchSystemConfigFromGas() {

  if (
    !CONFIG.GOOGLE_SCRIPT_URL
  ) {
    return;
  }

  try {

    const url =
      CONFIG.GOOGLE_SCRIPT_URL +
      (
        CONFIG.GOOGLE_SCRIPT_URL.includes('?')
          ? '&'
          : '?'
      ) +
      'action=getSystemConfig&t=' +
      Date.now();

    const response =
      await fetch(url);

    const result =
      await response.json();

    if (
      result &&
      result.status ===
        'success' &&
      result.data
    ) {

      const data =
        result.data;

      if (
        data.PROMPTPAY_NUMBER
      ) {

        CONFIG.PROMPTPAY_NUMBER =
          data.PROMPTPAY_NUMBER;
      }

      if (
        data.PROMPTPAY_NAME
      ) {

        CONFIG.PROMPTPAY_NAME =
          data.PROMPTPAY_NAME;
      }

      localStorage.setItem(
        'kmitl_pay_config',
        JSON.stringify(
          CONFIG
        )
      );
    }

  } catch (err) {

    console.warn(
      'Fetch system config error:',
      err
    );
  }
}

// ==========================================
// PROMPTPAY MASK
// ==========================================

function maskPromptPay(
  number
) {

  if (!number) {
    return '';
  }

  const str =
    number
      .toString()
      .trim();

  if (
    str.length ===
    10
  ) {

    return (
      str.substring(
        0,
        3
      ) +
      '-xxx-' +
      str.substring(
        6
      )
    );
  }

  if (
    str.length ===
    13
  ) {

    return (
      str.substring(
        0,
        4
      ) +
      '-xxxxx-xxx-' +
      str.substring(
        12
      )
    );
  }

  return (
    str.substring(
      0,
      Math.floor(
        str.length / 2
      )
    ) +
    'xxx'
  );
}

// ==========================================
// TOAST
// ==========================================

function showToast(
  message,
  type = 'info'
) {

  const container =
    document.getElementById(
      'toastContainer'
    );

  if (!container) {
    return;
  }

  const toast =
    document.createElement(
      'div'
    );

  toast.className =
    `toast toast-${type}`;

  let icon =
    'fa-info-circle';

  if (
    type ===
    'success'
  ) {
    icon =
      'fa-circle-check';
  }

  if (
    type ===
    'error'
  ) {
    icon =
      'fa-circle-exclamation';
  }

  toast.innerHTML =
    `
    <i class="fa-solid ${icon}"></i>
    <span>
      ${escapeHtml(
        String(message)
      )}
    </span>
    `;

  container.appendChild(
    toast
  );

  setTimeout(
    () => {

      toast.style.opacity =
        '0';

      setTimeout(
        () => {

          toast.remove();

        },
        300
      );

    },
    3500
  );
}

// ==========================================
// ESCAPE HTML
// ==========================================

function escapeHtml(
  str
) {

  if (
    str ===
    null ||
    str ===
    undefined
  ) {
    return '';
  }

  return String(
    str
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}

// ==========================================
// POST TO GOOGLE APPS SCRIPT
// ==========================================

async function postToGasReliable(
  data
) {

  const gasUrl =
    CONFIG.GOOGLE_SCRIPT_URL;

  if (!gasUrl) {

    throw new Error(
      'ยังไม่ได้ตั้งค่า Google Script URL'
    );
  }

  const params =
    new URLSearchParams();

  for (
    const key in data
  ) {

    if (
      key ===
      'slipBase64'
    ) {
      continue;
    }

    if (
      data[key] ===
      null ||
      data[key] ===
      undefined
    ) {
      continue;
    }

    if (
      typeof data[key] ===
      'object'
    ) {
      continue;
    }

    if (
      String(
        data[key]
      ).length >=
      300
    ) {
      continue;
    }

    params.append(
      key,
      data[key]
    );
  }

  const fetchUrl =
    gasUrl +
    (
      gasUrl.includes('?')
        ? '&'
        : '?'
    ) +
    params.toString();

  const jsonPayload =
    JSON.stringify(
      data
    );

  console.log(
    '[GAS] Sending:',
    data.action
  );

  try {

    await fetch(
      fetchUrl,
      {
        method:
          'POST',

        mode:
          'no-cors',

        headers: {
          'Content-Type':
            'text/plain;charset=utf-8'
        },

        body:
          jsonPayload
      }
    );

    console.log(
      '[GAS] POST sent:',
      data.action
    );

    return {
      status:
        'success'
    };

  } catch (err) {

    console.warn(
      '[GAS] POST failed. Using hidden form fallback:',
      err
    );

    return sendViaHiddenForm(
      gasUrl,
      data
    );
  }
}

// ==========================================
// HIDDEN FORM FALLBACK
// ==========================================

function sendViaHiddenForm(
  url,
  data
) {

  return new Promise(
    resolve => {

      try {

        let iframe =
          document.getElementById(
            'gas_hidden_iframe'
          );

        if (!iframe) {

          iframe =
            document.createElement(
              'iframe'
            );

          iframe.id =
            'gas_hidden_iframe';

          iframe.name =
            'gas_hidden_iframe';

          iframe.style.display =
            'none';

          document.body.appendChild(
            iframe
          );
        }

        const form =
          document.createElement(
            'form'
          );

        form.method =
          'POST';

        form.action =
          url;

        form.target =
          'gas_hidden_iframe';

        form.style.display =
          'none';

        const input =
          document.createElement(
            'input'
          );

        input.type =
          'hidden';

        input.name =
          'payload';

        input.value =
          JSON.stringify(
            data
          );

        form.appendChild(
          input
        );

        document.body.appendChild(
          form
        );

        form.submit();

        setTimeout(
          () => {

            form.remove();

            resolve({
              status:
                'success',

              fallback:
                true
            });

          },
          1500
        );

      } catch (e) {

        console.error(
          'Hidden form submission failed:',
          e
        );

        resolve({
          status:
            'error',

          message:
            e.message
        });
      }
    }
  );
}
