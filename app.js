// Student Initial Dataset
const initialStudents = [
  { id: "69010012", name: "เก้า" },
  { id: "69010024", name: "เซเว่น" },
  { id: "69010068", name: "เหนือเมฆ" },
  { id: "69010078", name: "ไตเติ้ล" },
  { id: "69010115", name: "โอม" },
  { id: "69010165", name: "น้ำเย็น" },
  { id: "69010188", name: "ถั่วพู" },
  { id: "69010202", name: "ฟลุ๊ค" },
  { id: "69010215", name: "จอม" },
  { id: "69010253", name: "ลีโอ" },
  { id: "69010320", name: "ปาย" },
  { id: "69010375", name: "วินเนอร์" },
  { id: "69010433", name: "ยอด" },
  { id: "69010472", name: "เกม" },
  { id: "69010588", name: "ทู" },
  { id: "69010626", name: "โมเม" },
  { id: "69010649", name: "ตี๋" },
  { id: "69010650", name: "ทัต" },
  { id: "69010760", name: "บิว" },
  { id: "69010798", name: "ปาแปง" },
  { id: "69010810", name: "บอส" },
  { id: "69010835", name: "เม้ว" },
  { id: "69010836", name: "ไนน์" },
  { id: "69010854", name: "กัส" },
  { id: "69010869", name: "ภู" },
  { id: "69010911", name: "ต้นยาง" },
  { id: "69011055", name: "ยู" },
  { id: "69011059", name: "พีค" },
  { id: "69011134", name: "ปลื้ม" },
  { id: "69011267", name: "แฟร้งค์" },
  { id: "69011606", name: "โอชิ" },
  { id: "69011613", name: "เก้า" },
  { id: "69011623", name: "โอ๊ค" },
  { id: "69011672", name: "แพททริค" },
  { id: "69011750", name: "ภูผา" },
  { id: "69011806", name: "เมธัส" },
  { id: "69011824", name: "เก็ต" },
  { id: "69011850", name: "ต้นน้ำ" }
];

const STORAGE_KEY = 'payment_checklist_students_v1';
const SOUND_KEY = 'payment_checklist_sound_enabled';
const SHEET_URL_KEY = 'payment_checklist_sheet_webapp_url';

// App State
let students = [];
let activeFilter = 'all';
let soundEnabled = true;
let activeSuggestionIndex = -1;
let webAppUrl = '';

// DOM Elements
const quickInput = document.getElementById('quick-input');
const clearInputBtn = document.getElementById('clear-input-btn');
const btnTickSubmit = document.getElementById('btn-tick-submit');
const dropdown = document.getElementById('suggestions-dropdown');
const studentGrid = document.getElementById('student-grid');
const emptyState = document.getElementById('empty-state');

// Stats Elements
const statTotal = document.getElementById('stat-total');
const statPaid = document.getElementById('stat-paid');
const statUnpaid = document.getElementById('stat-unpaid');
const progressText = document.getElementById('progress-text');
const progressFill = document.getElementById('progress-fill');

const countAll = document.getElementById('count-all');
const countUnpaid = document.getElementById('count-unpaid');
const countPaid = document.getElementById('count-paid');

// Action Buttons
const btnCopyUnpaid = document.getElementById('btn-copy-unpaid');
const btnSoundToggle = document.getElementById('btn-sound-toggle');
const btnResetAll = document.getElementById('btn-reset-all');

// Google Sheet Elements
const sheetStatusBadge = document.getElementById('sheet-status-badge');
const sheetStatusText = document.getElementById('sheet-status-text');
const btnOpenSheetSettings = document.getElementById('btn-open-sheet-settings');
const btnSyncSheet = document.getElementById('btn-sync-sheet');

const sheetModalOverlay = document.getElementById('sheet-modal-overlay');
const webAppUrlInput = document.getElementById('web-app-url-input');
const sheetModalSaveBtn = document.getElementById('sheet-modal-save-btn');
const sheetModalCloseBtn = document.getElementById('sheet-modal-close-btn');

// Completion Modal Elements
const modalOverlay = document.getElementById('modal-overlay');
const modalTitle = document.getElementById('modal-title');
const modalDesc = document.getElementById('modal-desc');
const modalEmoji = document.getElementById('modal-emoji');
const modalConfirmBtn = document.getElementById('modal-confirm-btn');
const modalCancelBtn = document.getElementById('modal-cancel-btn');

let currentModalAction = null;

// Initialize Application
function initApp() {
  loadSoundSetting();
  loadStudentsState();
  loadSheetUrlSetting();
  setupEventListeners();
  render();

  if (webAppUrl) {
    syncFromGoogleSheet();
  }
}

// Load state from localStorage
function loadStudentsState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      students = JSON.parse(saved);
      if (!Array.isArray(students) || students.length !== initialStudents.length) {
        students = mergeWithInitialState(students);
      }
    } catch (e) {
      console.error('Failed to parse saved state:', e);
      students = initialStudents.map(s => ({ ...s, paid: false, paidAt: null }));
    }
  } else {
    students = initialStudents.map(s => ({ ...s, paid: false, paidAt: null }));
  }
}

function mergeWithInitialState(savedList) {
  const map = new Map(savedList.map(s => [s.id, s]));
  return initialStudents.map(init => {
    const existing = map.get(init.id);
    return {
      ...init,
      paid: existing ? !!existing.paid : false,
      paidAt: existing ? existing.paidAt : null
    };
  });
}

function saveStudentsState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(students));
}

function loadSoundSetting() {
  const saved = localStorage.getItem(SOUND_KEY);
  soundEnabled = saved !== 'false';
  updateSoundIcon();
}

function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem(SOUND_KEY, soundEnabled);
  updateSoundIcon();
  showToast(soundEnabled ? '🔊 เปิดเสียงเอฟเฟกต์แล้ว' : '🔇 ปิดเสียงเอฟเฟกต์แล้ว', 'info');
}

function updateSoundIcon() {
  btnSoundToggle.textContent = soundEnabled ? '🔊' : '🔇';
}

function loadSheetUrlSetting() {
  webAppUrl = localStorage.getItem(SHEET_URL_KEY) || '';
  webAppUrlInput.value = webAppUrl;
  updateSheetStatusUI();
}

function updateSheetStatusUI(isSyncing = false) {
  if (isSyncing) {
    sheetStatusBadge.className = 'sheet-badge syncing';
    sheetStatusText.textContent = 'กำลังซิงค์ข้อมูลกับ Google Sheet...';
    btnSyncSheet.style.display = 'inline-flex';
    return;
  }

  if (webAppUrl) {
    sheetStatusBadge.className = 'sheet-badge online';
    sheetStatusText.textContent = 'เชื่อมต่อ Google Sheet แล้ว';
    btnSyncSheet.style.display = 'inline-flex';
  } else {
    sheetStatusBadge.className = 'sheet-badge offline';
    sheetStatusText.textContent = 'ยังไม่ได้เชื่อมต่อ Google Sheet';
    btnSyncSheet.style.display = 'none';
  }
}

// Sync All Data From Google Sheet
async function syncFromGoogleSheet() {
  if (!webAppUrl) return;

  updateSheetStatusUI(true);

  try {
    const url = `${webAppUrl}?action=getStudents&t=${Date.now()}`;
    const res = await fetch(url);
    const result = await res.json();

    if (result.status === 'success' && Array.isArray(result.data)) {
      const sheetDataMap = new Map(result.data.map(item => [item.id, item]));

      students = students.map(st => {
        const sheetItem = sheetDataMap.get(st.id);
        if (sheetItem) {
          return {
            ...st,
            paid: !!sheetItem.paid,
            paidAt: sheetItem.paidAt || (sheetItem.paid ? 'จ่ายแล้ว' : null)
          };
        }
        return st;
      });

      saveStudentsState();
      updateSheetStatusUI(false);
      render();
      showToast('🟢 ดึงข้อมูลล่าสุดจาก Google Sheet สำเร็จ', 'success');
    } else {
      updateSheetStatusUI(false);
      showToast('⚠️ ไม่สามารถดึงข้อมูลจาก Google Sheet ได้', 'warning');
    }
  } catch (err) {
    console.error('Google Sheet Sync Error:', err);
    updateSheetStatusUI(false);
    showToast('❌ การเชื่อมต่อ Google Sheet ล้มเหลว โปรดเช็ค Web App URL', 'danger');
  }
}

// Sync Single Student Status Update to Google Sheet
async function syncSingleStudentToSheet(student) {
  if (!webAppUrl) return;

  try {
    const url = `${webAppUrl}?action=updateStatus&id=${encodeURIComponent(student.id)}&paid=${student.paid}&paidAt=${encodeURIComponent(student.paidAt || '')}`;
    fetch(url, { mode: 'no-cors' }).catch(err => console.error('BG Sync Error:', err));
  } catch (e) {
    // Ignore async background sync errors
  }
}

// Sync Reset All to Google Sheet
async function syncResetAllToSheet() {
  if (!webAppUrl) return;

  try {
    const url = `${webAppUrl}?action=resetAll`;
    fetch(url, { mode: 'no-cors' }).catch(err => console.error('BG Sync Error:', err));
  } catch (e) {}
}

// Sound synthesizer using Web Audio API
function playSound(type) {
  if (!soundEnabled) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(783.99, ctx.currentTime + 0.15);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'victory') {
      const notes = [523.25, 659.25, 783.99, 1046.50];
      notes.forEach((freq, idx) => {
        const subOsc = ctx.createOscillator();
        const subGain = ctx.createGain();
        subOsc.type = 'triangle';
        subOsc.frequency.value = freq;
        subOsc.connect(subGain);
        subGain.connect(ctx.destination);
        const startTime = ctx.currentTime + idx * 0.1;
        subGain.gain.setValueAtTime(0.3, startTime);
        subGain.gain.exponentialRampToValueAtTime(0.01, startTime + 0.25);
        subOsc.start(startTime);
        subOsc.stop(startTime + 0.25);
      });
    } else if (type === 'toggle-off') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(330, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    }
  } catch (e) {}
}

// Event Listeners Setup
function setupEventListeners() {
  quickInput.addEventListener('input', handleInputChange);
  quickInput.addEventListener('keydown', handleInputKeyDown);
  
  clearInputBtn.addEventListener('click', () => {
    quickInput.value = '';
    hideSuggestions();
    clearInputBtn.style.display = 'none';
    quickInput.focus();
    render();
  });
  
  btnTickSubmit.addEventListener('click', processCurrentInput);
  
  document.addEventListener('click', (e) => {
    if (!quickInput.contains(e.target) && !dropdown.contains(e.target)) {
      hideSuggestions();
    }
  });

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  btnCopyUnpaid.addEventListener('click', copyUnpaidList);
  btnSoundToggle.addEventListener('click', toggleSound);
  btnResetAll.addEventListener('click', promptResetAll);

  // Google Sheet Modal & Action events
  btnOpenSheetSettings.addEventListener('click', () => {
    webAppUrlInput.value = webAppUrl;
    sheetModalOverlay.classList.add('show');
  });

  sheetModalCloseBtn.addEventListener('click', () => {
    sheetModalOverlay.classList.remove('show');
  });

  sheetModalSaveBtn.addEventListener('click', () => {
    const inputUrl = webAppUrlInput.value.trim();
    webAppUrl = inputUrl;
    localStorage.setItem(SHEET_URL_KEY, webAppUrl);
    updateSheetStatusUI();
    sheetModalOverlay.classList.remove('show');

    if (webAppUrl) {
      showToast('💾 บันทึก Web App URL เรียบร้อยแล้ว กำลังซิงค์ข้อมูล...', 'info');
      syncFromGoogleSheet();
    } else {
      showToast('ℹ️ ปิดการเชื่อมต่อ Google Sheet แล้ว', 'info');
    }
  });

  btnSyncSheet.addEventListener('click', () => {
    syncFromGoogleSheet();
  });

  // Completion Modal actions
  modalConfirmBtn.addEventListener('click', () => {
    if (currentModalAction) currentModalAction();
    hideModal();
  });
  modalCancelBtn.addEventListener('click', hideModal);
}

function handleInputChange() {
  const query = quickInput.value.trim();
  clearInputBtn.style.display = query ? 'flex' : 'none';
  
  if (!query) {
    hideSuggestions();
    render();
    return;
  }

  showSuggestions(query);
  render();
}

function showSuggestions(query) {
  const matches = getMatchingStudents(query);
  if (matches.length === 0) {
    hideSuggestions();
    return;
  }

  activeSuggestionIndex = -1;
  dropdown.innerHTML = matches.map((st, idx) => `
    <div class="suggestion-item" data-id="${st.id}" data-idx="${idx}">
      <div class="suggestion-info">
        <span class="suggestion-id">${st.id}</span>
        <span class="suggestion-name">${st.name}</span>
      </div>
      <span class="suggestion-status ${st.paid ? 'status-tag-paid' : 'status-tag-unpaid'}">
        ${st.paid ? '✅ จ่ายแล้ว' : '⏳ ยังไม่จ่าย'}
      </span>
    </div>
  `).join('');

  dropdown.style.display = 'block';

  dropdown.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('click', () => {
      const studentId = item.dataset.id;
      togglePaidStatus(studentId, true);
      quickInput.value = '';
      clearInputBtn.style.display = 'none';
      hideSuggestions();
      quickInput.focus();
    });
  });
}

function hideSuggestions() {
  dropdown.style.display = 'none';
  activeSuggestionIndex = -1;
}

function getMatchingStudents(query) {
  const q = query.toLowerCase().trim();
  return students.filter(st => 
    st.id.includes(q) || st.name.toLowerCase().includes(q)
  );
}

function handleInputKeyDown(e) {
  const items = dropdown.querySelectorAll('.suggestion-item');

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (items.length === 0) return;
    activeSuggestionIndex = (activeSuggestionIndex + 1) % items.length;
    updateSuggestionHighlight(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (items.length === 0) return;
    activeSuggestionIndex = (activeSuggestionIndex - 1 + items.length) % items.length;
    updateSuggestionHighlight(items);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (dropdown.style.display === 'block' && activeSuggestionIndex >= 0 && items[activeSuggestionIndex]) {
      items[activeSuggestionIndex].click();
    } else {
      processCurrentInput();
    }
  } else if (e.key === 'Escape') {
    hideSuggestions();
  }
}

function updateSuggestionHighlight(items) {
  items.forEach((item, idx) => {
    if (idx === activeSuggestionIndex) {
      item.classList.add('active');
      item.scrollIntoView({ block: 'nearest' });
    } else {
      item.classList.remove('active');
    }
  });
}

function processCurrentInput() {
  const query = quickInput.value.trim();
  if (!query) {
    showToast('⚠️ กรุณาพิมพ์ชื่อหรือรหัสนักศึกษา', 'warning');
    return;
  }

  const exactIdMatch = students.find(s => s.id === query);
  if (exactIdMatch) {
    togglePaidStatus(exactIdMatch.id, true);
    resetInput();
    return;
  }

  const nameMatches = students.filter(s => s.name.toLowerCase() === query.toLowerCase());

  if (nameMatches.length === 1) {
    togglePaidStatus(nameMatches[0].id, true);
    resetInput();
    return;
  } else if (nameMatches.length > 1) {
    const unpaidMatch = nameMatches.find(s => !s.paid);
    if (unpaidMatch) {
      togglePaidStatus(unpaidMatch.id, true);
      showToast(`✅ ติ๊กจ่ายให้: ${unpaidMatch.id} ${unpaidMatch.name} (จาก ${nameMatches.length} คนที่มีชื่อเดียวกัน)`, 'success');
      resetInput();
      return;
    } else {
      showToast(`ℹ️ นักศึกษาที่ชื่อ "${query}" จ่ายครบแล้วทุกคน`, 'info');
      resetInput();
      return;
    }
  }

  const partialMatches = getMatchingStudents(query);
  if (partialMatches.length === 1) {
    togglePaidStatus(partialMatches[0].id, true);
    resetInput();
    return;
  } else if (partialMatches.length > 1) {
    const unpaidPartial = partialMatches.find(s => !s.paid);
    if (unpaidPartial) {
      togglePaidStatus(unpaidPartial.id, true);
      resetInput();
      return;
    } else {
      togglePaidStatus(partialMatches[0].id, true);
      resetInput();
      return;
    }
  } else {
    showToast(`❌ ไม่พบข้อมูลนักศึกษา "${query}"`, 'danger');
  }
}

function resetInput() {
  quickInput.value = '';
  clearInputBtn.style.display = 'none';
  hideSuggestions();
  quickInput.focus();
  render();
}

function togglePaidStatus(studentId, forcePaid = false) {
  const student = students.find(s => s.id === studentId);
  if (!student) return;

  if (forcePaid) {
    student.paid = true;
    student.paidAt = new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
  } else {
    student.paid = !student.paid;
    student.paidAt = student.paid ? new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) : null;
  }

  saveStudentsState();

  // Send update to Google Sheet in background
  syncSingleStudentToSheet(student);

  if (student.paid) {
    playSound('success');
    showToast(`✅ ติ๊กจ่ายแล้ว: ${student.id} ${student.name}`, 'success');
  } else {
    playSound('toggle-off');
    showToast(`⏳ ยกเลิกสถานะ: ${student.id} ${student.name}`, 'warning');
  }

  render(studentId);
  checkCompletionState();
}

function checkCompletionState() {
  const total = students.length;
  const paidCount = students.filter(s => s.paid).length;

  if (total > 0 && paidCount === total) {
    setTimeout(() => {
      triggerConfetti();
      playSound('victory');
      showCompletionModal();
    }, 400);
  }
}

function render(highlightStudentId = null) {
  const total = students.length;
  const paidCount = students.filter(s => s.paid).length;
  const unpaidCount = total - paidCount;
  const percent = total > 0 ? Math.round((paidCount / total) * 100) : 0;

  statTotal.textContent = total;
  statPaid.textContent = paidCount;
  statUnpaid.textContent = unpaidCount;
  
  countAll.textContent = total;
  countUnpaid.textContent = unpaidCount;
  countPaid.textContent = paidCount;

  progressText.textContent = `${percent}%`;
  progressFill.style.width = `${percent}%`;

  const searchQuery = quickInput.value.trim().toLowerCase();
  
  let filtered = students.filter(st => {
    if (activeFilter === 'paid' && !st.paid) return false;
    if (activeFilter === 'unpaid' && st.paid) return false;

    if (searchQuery) {
      return st.id.includes(searchQuery) || st.name.toLowerCase().includes(searchQuery);
    }
    return true;
  });

  if (filtered.length === 0) {
    studentGrid.style.display = 'none';
    emptyState.style.display = 'block';
    return;
  }

  studentGrid.style.display = 'grid';
  emptyState.style.display = 'none';

  studentGrid.innerHTML = filtered.map((st) => {
    const isJustUpdated = st.id === highlightStudentId;
    return `
      <div 
        class="student-card ${st.paid ? 'paid' : ''} ${isJustUpdated ? 'just-updated' : ''}" 
        data-id="${st.id}"
      >
        <div class="student-left">
          <div class="checkbox-custom">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="student-details">
            <span class="student-id">${st.id}</span>
            <span class="student-name">${st.name}</span>
          </div>
        </div>
        <span class="student-badge ${st.paid ? 'badge-paid' : 'badge-unpaid'}">
          ${st.paid ? `จ่ายแล้ว ${st.paidAt ? `(${st.paidAt})` : ''}` : 'ยังไม่จ่าย'}
        </span>
      </div>
    `;
  }).join('');

  studentGrid.querySelectorAll('.student-card').forEach(card => {
    card.addEventListener('click', () => {
      togglePaidStatus(card.dataset.id);
    });
  });

  if (highlightStudentId) {
    const targetCard = studentGrid.querySelector(`[data-id="${highlightStudentId}"]`);
    if (targetCard) {
      targetCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
}

function copyUnpaidList() {
  const unpaid = students.filter(s => !s.paid);
  if (unpaid.length === 0) {
    showToast('🎉 ทุกคนชำระเงินเรียบร้อยแล้ว ไม่พบคนที่ยังไม่จ่าย', 'info');
    return;
  }

  let text = `📋 รายชื่อผู้ที่ยังไม่ได้ชำระเงิน (${unpaid.length} คน):\n`;
  text += `-----------------------------------\n`;
  unpaid.forEach((st, idx) => {
    text += `${idx + 1}. ${st.id} ${st.name}\n`;
  });

  navigator.clipboard.writeText(text).then(() => {
    showToast(`📋 คัดลอกรายชื่อคนยังไม่จ่าย (${unpaid.length} คน) เรียบร้อยแล้ว`, 'success');
  }).catch(err => {
    console.error('Clipboard copy failed:', err);
    showToast('❌ ไม่สามารถคัดลอกข้อความได้', 'danger');
  });
}

function promptResetAll() {
  modalEmoji.textContent = '🔄';
  modalTitle.textContent = 'ยืนยันการรีเซ็ตข้อมูล';
  modalDesc.textContent = 'คุณต้องการรีเซ็ตสถานะการชำระเงินทั้งหมดของทั้ง 38 คน ให้กลับเป็น "ยังไม่จ่าย" ใช่หรือไม่?';
  modalConfirmBtn.textContent = 'ใช่, รีเซ็ตข้อมูลทั้งหมด';
  modalConfirmBtn.className = 'btn-modal-primary';

  currentModalAction = () => {
    students = students.map(s => ({ ...s, paid: false, paidAt: null }));
    saveStudentsState();
    syncResetAllToSheet();
    playSound('toggle-off');
    showToast('🔄 รีเซ็ตข้อมูลการชำระเงินทั้งหมดเรียบร้อยแล้ว', 'info');
    quickInput.value = '';
    hideSuggestions();
    render();
  };

  showModal();
}

function showCompletionModal() {
  modalEmoji.textContent = '🎉';
  modalTitle.textContent = 'จ่ายเงินครบทุกคนแล้ว!';
  modalDesc.textContent = 'ยินดีด้วย! นักศึกษาทั้ง 38 คนชำระเงินเรียบร้อยแล้ว คุณต้องการรีเซ็ตเพื่อเริ่มรอบใหม่หรือไม่?';
  modalConfirmBtn.textContent = 'รีเซ็ตเพื่อเริ่มรอบใหม่';
  modalConfirmBtn.className = 'btn-modal-primary';

  currentModalAction = () => {
    students = students.map(s => ({ ...s, paid: false, paidAt: null }));
    saveStudentsState();
    syncResetAllToSheet();
    showToast('✨ เริ่มต้นรอบใหม่เรียบร้อยแล้ว', 'success');
    render();
  };

  showModal();
}

function showModal() {
  modalOverlay.classList.add('show');
}

function hideModal() {
  modalOverlay.classList.remove('show');
  currentModalAction = null;
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(100%)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

function triggerConfetti() {
  if (typeof confetti === 'function') {
    confetti({
      particleCount: 120,
      spread: 80,
      origin: { y: 0.6 }
    });
  }
}

document.addEventListener('DOMContentLoaded', initApp);
