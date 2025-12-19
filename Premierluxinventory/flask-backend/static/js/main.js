/**
 * PREMIERLUX INVENTORY SYSTEM - MAIN LOGIC
 * Consolidated & Cleaned Version
 */

let currentUserRole = 'admin';

// --- API CONFIGURATION ---
const API_BASE = "http://127.0.0.1:5000";
const API_URL = `${API_BASE}/api/inventory`;
const BRANCHES_API_URL = `${API_BASE}/api/branches`;
const ALERTS_API_URL = `${API_BASE}/api/alerts`;
const SUPPLIERS_API_URL = `${API_BASE}/api/suppliers`;
const ORDERS_API_URL = `${API_BASE}/api/orders`;
const REPLENISH_API_URL = `${API_BASE}/api/replenishment/recommendations`;

// Chart Instances
let dashBranchChart = null;
let dashCategoryChart = null;
let analyticsMainChart = null;
let stockInOutChart = null;
let analyticsSocket = null;
let lastAnalyticsPayload = null;
let currentAnalyticsBranch = 'All'
let pendingHighlightItem = null;
// ==========================================
// 1. GLOBAL HELPERS & STATE
// ==========================================

// Global Notification State
window.bellState = {
    lowStockItems: [],
    expiringItems: [],
    apiAlerts: []
};

// Toggle Visibility Helper (Fix: Closes others first)
window.toggleMenu = function (menuId) {
    const menu = document.getElementById(menuId);
    if (!menu) return;


    const isCurrentlyOpen = !menu.classList.contains('invisible');


    closeAllDropdowns();

    if (!isCurrentlyOpen) {
        menu.classList.remove('invisible', 'opacity-0');
    }
};


window.closeAllDropdowns = function () {
    document.querySelectorAll('.nav-dropdown').forEach(d => {
        d.classList.add('invisible', 'opacity-0');
    });
};

// Close Dropdowns when clicking outside
window.addEventListener('click', (e) => {
    const isInsideMenu = e.target.closest('[data-menu-root]');

    if (!isInsideMenu) {
        closeAllDropdowns();
    }
});

function showToast(message) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    setTimeout(() => toast.classList.add('hidden'), 2500);
}

// ==========================================
// 2. PAGE NAVIGATION & INIT (Fixed)
// ==========================================

function showPage(page) {
    const sections = [
        'dashboard-section', 'inventory-section', 'branches-section',
        'orders-section', 'suppliers-section', 'compliance-section',
        'qr-section', 'admin-suppliers-section', 'admin-roles-section',
        'admin-logs-section', 'admin-accounts-section', 'analytics-section', 'admin-settings-section'
    ];

    // Hide all sections
    sections.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });

    closeAllDropdowns();

    // Show target
    const target = document.getElementById(page + '-section');
    if (target) target.classList.remove('hidden');

    if (page === 'qr') {
        // Stop scanner if running
        if (typeof stopQrScanner === 'function') stopQrScanner();

        // Reset Result UI
        const card = document.getElementById('qrResultCard');
        const empty = document.getElementById('qrEmptyState');
        if (card) card.classList.add('hidden');
        if (empty) empty.classList.remove('hidden');
    }

    if (page === 'dashboard') {
        initDashboard();
        fetchAlertsForBell();
        fetchBatchesForAlerts();
        fetchInventory();


        if (typeof fetchPriceInsights === 'function') {
            fetchPriceInsights();
        }
    }

    if (page === 'inventory') {
        fetchBranches(branches => {
            updateBranchSelect(branches);
        });
        fetchInventory();
    }

    if (page === 'branches') {
        fetchBranches();
    }

    if (page === 'suppliers') {
        fetchSuppliers();
    }

    if (page === 'orders') {
        fetchOrders();
    }

    if (page === 'analytics') {
        if (typeof initAnalyticsOverview === 'function') initAnalyticsOverview();
        if (typeof initAnalyticsSocket === 'function') initAnalyticsSocket();
        // Redraw charts if we have cached data
        if (lastAnalyticsPayload && typeof drawAnalytics === 'function') {
            drawAnalytics(lastAnalyticsPayload);
        }
    }
    if (page === 'compliance') {
        fetchComplianceData();
    }
    if (page === 'admin-accounts') {
        fetchUsers();
    }
    if (page === 'admin-roles') {
        fetchRoleStats();
    }
    if (page === 'admin-settings') {
        initOwnerSettings();
    }

    if (page === 'analytics' || page === 'dashboard') {
        fetchPriceInsights();
    }
}
// Init on Load
window.onload = function () {

    // --- 1. SESSION CHECK (Main.js Only Version) ---
    // We check if the session is active OR if the user just arrived from the login page.
    const isActive = sessionStorage.getItem("isActiveSession");
    const cameFromLogin = document.referrer.includes("/login");

    checkCurrentUser();

    if (cameFromLogin || isActive) {
        // If they just logged in, or already have a tab open, mark this window as safe.
        sessionStorage.setItem("isActiveSession", "true");
    } else {
        // If they opened the browser fresh (no flag, didn't come from login), force logout.
        console.log("Session invalid or browser closed. Logging out...");
        doLogout();
        return; // Stop loading the dashboard
    }
    // ----------------------------------------------

    // 2. Attach listener for Add Branch
    const addBranchBtn = document.getElementById('addBranchBtn');
    if (addBranchBtn) addBranchBtn.addEventListener('click', saveBranch);

    // 3. Start Dashboard Logic
    showPage('dashboard');
    loadAiDashboard();

    // 4. Handle Splash Screen
    setTimeout(() => {
        hideSplashScreen();
    }, 2500);
};


// ==========================================
// 3. DASHBOARD LOGIC
// ==========================================

async function initDashboard() {
    console.log("Initializing Dashboard...");
    try {
        const [invRes, branchRes, aiRes] = await Promise.all([
            fetch(API_URL).then(r => r.json()),
            fetch(BRANCHES_API_URL).then(r => r.json()),
            fetch(`${API_BASE}/api/ai/dashboard`).then(r => r.json())
        ]);

        // KPIs
        const totalValue = invRes.reduce((acc, item) => acc + ((item.price || 0) * (item.quantity || 0)), 0);
        const lowStockItems = invRes.filter(item => (item.quantity || 0) <= (item.reorder_level || 0));
        const expiringCount = window.bellState.expiringItems.length;

        document.getElementById('dash-total-value').textContent = `₱${totalValue.toLocaleString('en-PH', { maximumFractionDigits: 0 })}`;
        document.getElementById('dash-low-stock').textContent = lowStockItems.length;
        document.getElementById('dash-expiring').textContent = expiringCount;
        document.getElementById('dash-branches').textContent = branchRes.length;
        document.getElementById('dash-timestamp').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // AI Card
        if (aiRes) applyAiDashboardToCards(aiRes);

        // Restock Table (Top 5 Critical)
        const restockTable = document.getElementById('dash-restock-table');
        if (restockTable) {
            restockTable.innerHTML = '';
            const criticalItems = lowStockItems
                .sort((a, b) => ((a.quantity - a.reorder_level) - (b.quantity - b.reorder_level)))
                .slice(0, 5);

            criticalItems.forEach(item => {
                const row = `
                <tr class="border-b border-slate-50 last:border-0 transition-colors duration-200 hover:bg-emerald-50/50">
                    <td class="px-6 py-3 font-medium text-slate-700">${item.name}</td>
                    <td class="px-6 py-3 text-xs text-slate-500">${item.branch}</td>
                    <td class="px-6 py-3 text-right font-bold text-rose-600">${item.quantity}</td>
                    <td class="px-6 py-3 text-center">
<button onclick="openRestockModal('${item.name.replace(/'/g, "\\'")}', '${item.branch}', ${item.quantity})" 
    class="bg-emerald-50 text-emerald-600 hover:bg-emerald-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-bold transition-all duration-150 shadow-sm active:scale-95">
    Restock
</button>
                    </td>
                </tr>`;
                restockTable.innerHTML += row;
            });
        }

        // Charts
        renderGradientBranchChart(invRes);
        renderCategoryDoughnut(invRes);
        initAIModule();

    } catch (err) {
        console.error("Dashboard Init Error:", err);
    }
}

// Gradient Bar Chart
function renderGradientBranchChart(inventory) {
    const ctx = document.getElementById('dashBranchChart')?.getContext('2d');
    if (!ctx) return;

    const branchMap = {};
    inventory.forEach(item => {
        const val = (item.price || 0) * (item.quantity || 0);
        const branchName = item.branch || 'Unassigned';
        branchMap[branchName] = (branchMap[branchName] || 0) + val;
    });

    const labels = Object.keys(branchMap);
    const data = Object.values(branchMap);

    // Define Plume Wine
    const wineColor = '#5E4074';

    const gradient = ctx.createLinearGradient(0, 0, 0, 400);
    gradient.addColorStop(0, wineColor);
    gradient.addColorStop(0.8, 'rgba(94, 64, 116, 0.1)'); // Transparent Wine

    if (dashBranchChart) dashBranchChart.destroy();

    dashBranchChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Stock Value',
                data: data,
                backgroundColor: gradient,
                borderRadius: 8,
                borderSkipped: false,
                barPercentage: 0.5,
                categoryPercentage: 0.8
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
                y: { beginAtZero: true, grid: { color: '#f1f5f9', borderDash: [5, 5] }, ticks: { callback: (val) => '₱' + (val / 1000) + 'k' } },
                x: { grid: { display: false } }
            }
        }
    });
}

// Doughnut Chart with Plugin
function renderCategoryDoughnut(inventory) {
    const ctx = document.getElementById('dashCategoryChart')?.getContext('2d');
    if (!ctx) return;

    const catMap = {};
    inventory.forEach(item => {
        const cat = item.category || 'Uncategorized';
        catMap[cat] = (catMap[cat] || 0) + 1;
    });

    const labels = Object.keys(catMap);
    const data = Object.values(catMap);
    const totalItems = inventory.length;

    if (dashCategoryChart) dashCategoryChart.destroy();

    const textCenterPlugin = {
        id: 'textCenter',
        beforeDraw: function (chart) {
            const { ctx, chartArea: { top, bottom, left, right } } = chart;
            ctx.save();
            const centerX = (left + right) / 2;
            const centerY = (top + bottom) / 2;
            ctx.font = `900 2.5em sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = "#1e293b";
            ctx.fillText(totalItems, centerX, centerY - 10);
            ctx.font = "bold 0.7em sans-serif";
            ctx.fillStyle = "#94a3b8";
            ctx.fillText("TOTAL ITEMS", centerX, centerY + 15);
            ctx.restore();
        }
    };

    dashCategoryChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: [
                    '#5E4074', // Plume Wine (Main)
                    '#8D6E9E', // Lighter Purple
                    '#C4B2D1', // Pale Purple
                    '#B5A642', // Muted Gold (Compliments Wine)
                    '#64748b'  // Slate (Neutral)
                ],
                borderWidth: 0,
                hoverOffset: 5
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '75%',
            layout: { padding: 10 },
            plugins: {
                legend: { position: 'right', labels: { usePointStyle: true, pointStyle: 'circle', padding: 15 } }
            }
        },
        plugins: [textCenterPlugin]
    });
}


// ==========================================
// 4. INVENTORY LOGIC & CARDS
// ==========================================

function fetchInventory() {
    const search = document.getElementById('inventorySearch').value;
    const branch = document.getElementById('branchFilter').value; // Ensure this input exists

    // Show loading state if needed
    const grid = document.getElementById('inventoryCards');
    if (grid) grid.innerHTML = '<div class="col-span-full text-center text-slate-400 py-10">Loading inventory...</div>';

    let url = `${API_URL}?q=${encodeURIComponent(search)}`;
    if (branch && branch !== 'All') {
        url += `&branch=${encodeURIComponent(branch)}`;
    }

    fetch(url)
        .then(res => res.json())
        .then(data => {
            renderInventoryCards(data); // Draw the cards first
        })
        .catch(err => console.error("Error loading inventory:", err));
}

function renderInventoryCards(items) {
    const container = document.getElementById('inventoryCards');
    const emptyState = document.getElementById('inventoryEmptyState');
    if (!container) return;
    container.innerHTML = '';

    const currentBranch = document.getElementById('branchFilter')?.value || 'All';
    const searchInput = document.getElementById('inventorySearch');
    const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';

    const visibleItems = items.filter(item => {
        if (currentBranch !== 'All' && currentBranch !== '' && item.branch !== currentBranch) return false;
        if (searchTerm && !item.name.toLowerCase().includes(searchTerm)) return false;
        return true;
    });

    if (visibleItems.length === 0) {
        if (emptyState) emptyState.classList.remove('hidden');
    } else {
        if (emptyState) emptyState.classList.add('hidden');
    }

    visibleItems.forEach(item => {
        const card = document.createElement('div');

        // ➤ CRITICAL: Generate the exact same ID as the notification handler
        const rawString = `${item.name}-${item.branch || 'general'}`;
        const uniqueId = rawString.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        card.id = `card-${uniqueId}`;

        card.className = "group relative flex flex-col justify-between rounded-3xl bg-white border border-slate-100 shadow-md hover:shadow-xl hover:-translate-y-1 transition-all duration-300 cursor-pointer overflow-hidden h-full";
        card.onclick = () => openItemDetails(item);

        const isLow = (item.quantity || 0) <= (item.reorder_level || 0);
        const safeName = item.name.replace(/'/g, "\\'");
        const safeBranch = (item.branch || '').replace(/'/g, "\\'");
        const supplier = item.supplier_batch || 'Unknown Supplier';

        card.innerHTML = `
          <div class="h-1.5 w-full bg-gradient-to-r ${isLow ? 'from-rose-500 to-orange-400' : 'from-emerald-400 to-teal-500'}"></div>
          <div class="p-5 flex-1 flex flex-col">
              <div class="flex justify-between items-start mb-4">
                  <div>
                      <h3 class="font-extrabold text-slate-800 text-lg leading-tight mb-1 group-hover:text-emerald-600 transition-colors">${item.name}</h3>
                      <span class="inline-flex items-center justify-center px-2 py-0.5 rounded-md bg-slate-100 border border-slate-200 text-[10px] font-bold text-slate-500 uppercase tracking-wider">${item.branch || 'General'}</span>
                  </div>
                  <div class="flex flex-col items-end">
                      <span class="text-3xl font-black ${isLow ? 'text-rose-500' : 'text-slate-700'} tracking-tight">${item.quantity || 0}</span>
                      <span class="text-[9px] text-slate-400 font-bold uppercase">In Stock</span>
                  </div>
              </div>
              <div class="grid grid-cols-2 gap-2 mb-5">
                  <div class="bg-white/50 rounded-xl p-2 border border-white/60">
                      <span class="block text-[9px] uppercase text-slate-400 font-bold mb-0.5">Category</span>
                      <span class="text-xs font-semibold text-slate-600 truncate block">${item.category || '-'}</span>
                  </div>
                   <div class="bg-white/50 rounded-xl p-2 border border-white/60">
                      <span class="block text-[9px] uppercase text-slate-400 font-bold mb-0.5">Reorder Lvl</span>
                      <div class="flex items-center gap-1">
                          <span class="text-xs font-semibold text-slate-600">${item.reorder_level || 0}</span>
                          ${isLow ? '<span class="text-[9px] text-rose-500 font-bold animate-pulse">!</span>' : ''}
                      </div>
                  </div>
              </div>
              <div class="mt-auto grid grid-cols-[1fr_1.5fr_auto] gap-2 pt-4 border-t border-slate-100">
                <button onclick="event.stopPropagation(); openEditStockModal('${safeName}', '${safeBranch}', ${item.quantity || 0})" 
                    class="w-full py-2 rounded-xl bg-white border border-slate-200 text-slate-600 text-xs font-bold hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200 transition shadow-sm whitespace-nowrap">
                    Edit
                </button>
                <button onclick="event.stopPropagation(); openRestockModal('${safeName}', '${safeBranch}', ${item.quantity || 0})" 
                    class="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-100 text-xs font-bold hover:bg-emerald-600 hover:text-white transition shadow-sm whitespace-nowrap">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13L4.707 15.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z"></path></svg>
                    Reorder
                </button>
                <button onclick="event.stopPropagation(); confirmDelete('${safeName}')" 
                    class="w-9 h-9 flex items-center justify-center rounded-xl bg-rose-50 text-rose-400 border border-rose-100 hover:bg-rose-500 hover:text-white transition shadow-sm" title="Delete Item">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                </button>
            </div>
          </div>`;

        container.appendChild(card);

        // ➤ CRITICAL: Highlight Logic
        // Checks if the global pendingHighlight ID matches this card's unique ID
        if (window.pendingHighlight && window.pendingHighlight.id === uniqueId) {
            setTimeout(() => {
                const target = document.getElementById(`card-${uniqueId}`);
                if (target) {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    // Add yellow ring and flash animation
                    target.classList.add('highlight-pulse', 'ring-4', 'ring-amber-400', 'ring-offset-2');

                    // Remove after 3 seconds
                    setTimeout(() => {
                        target.classList.remove('highlight-pulse', 'ring-4', 'ring-amber-400', 'ring-offset-2');
                    }, 3000);
                }
            }, 600); // 600ms delay to ensure DOM is ready
            window.pendingHighlight = null; // Clear it so it doesn't flash again on next reload
        }
    });
}


function confirmDelete(name) {
    openDeleteModal('inventory', name);
}

function deleteItem(name) {
    fetch(`${API_URL}/${encodeURIComponent(name)}`, { method: 'DELETE' })
        .then(() => { fetchInventory(); initDashboard(); });
}

// --- CUSTOM INVENTORY DROPDOWN LOGIC (Glass Style) ---

function toggleBranchMenu() {
    const menu = document.getElementById('branchDropdownOptions');
    if (menu) menu.classList.toggle('hidden');
}

function selectBranch(value, label) {
    document.getElementById('branchFilter').value = value;
    const labelEl = document.getElementById('branchLabel');
    if (labelEl) labelEl.textContent = label;
    document.getElementById('branchDropdownOptions').classList.add('hidden');
    fetchInventory();
}

function updateBranchSelect(branches) {
    const container = document.getElementById('branchDropdownOptions');
    if (!container) return;
    container.innerHTML = '';
    container.innerHTML += `
        <button onclick="selectBranch('All', 'All branches')" 
            class="w-full text-left px-4 py-2.5 rounded-lg text-sm font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-600 transition">
            All branches
        </button>`;
    branches.forEach(b => {
        container.innerHTML += `
            <button onclick="selectBranch('${b.name}', '${b.name}')" 
                class="w-full text-left px-4 py-2.5 rounded-lg text-sm font-medium text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 transition">
                ${b.name}
            </button>`;
    });
}

// ==========================================
// UNIVERSAL CLICK OUTSIDE LISTENER
// ==========================================
window.addEventListener('click', (e) => {

    // 1. Navbar Dropdowns
    const isInsideNav = e.target.closest('[data-menu-root]');
    if (!isInsideNav) closeAllDropdowns();

    // 2. Inventory Branch Filter
    const iBtn = document.getElementById('branchDropdownBtn');
    const iMenu = document.getElementById('branchDropdownOptions');
    if (iBtn && iMenu && !iBtn.contains(e.target) && !iMenu.contains(e.target)) iMenu.classList.add('hidden');

    // 3. Restock Supplier Dropdown
    const rBtn = document.getElementById('restockSupplierBtn');
    const rMenu = document.getElementById('restockSupplierOptions');
    if (rBtn && rMenu && !rBtn.contains(e.target) && !rMenu.contains(e.target)) rMenu.classList.add('hidden');

    // 4. Batch Modal: Branch Dropdown
    const bBranchBtn = document.getElementById('batchBranchBtn');
    const bBranchMenu = document.getElementById('batchBranchOptions');
    if (bBranchBtn && bBranchMenu && !bBranchBtn.contains(e.target) && !bBranchMenu.contains(e.target)) bBranchMenu.classList.add('hidden');

    // 5. Batch Modal: Category Dropdown (NEW)
    const bCatBtn = document.getElementById('batchCategoryBtn');
    const bCatMenu = document.getElementById('batchCategoryOptions');
    if (bCatBtn && bCatMenu && !bCatBtn.contains(e.target) && !bCatMenu.contains(e.target)) bCatMenu.classList.add('hidden');

    // 6. Edit Stock: Action Dropdown (NEW)
    const eActBtn = document.getElementById('editActionBtn');
    const eActMenu = document.getElementById('editActionOptions');
    if (eActBtn && eActMenu && !eActBtn.contains(e.target) && !eActMenu.contains(e.target)) eActMenu.classList.add('hidden');

    // 7. Edit Stock: Reason Dropdown (NEW)
    const eReaBtn = document.getElementById('editReasonBtn');
    const eReaMenu = document.getElementById('editReasonOptions');
    if (eReaBtn && eReaMenu && !eReaBtn.contains(e.target) && !eReaMenu.contains(e.target)) eReaMenu.classList.add('hidden');

    // 8. User: Role & Branch
    const uRoleBtn = document.getElementById('roleDropdownBtn');
    const uRoleMenu = document.getElementById('roleDropdownOptions');
    if (uRoleBtn && uRoleMenu && !uRoleBtn.contains(e.target) && !uRoleMenu.contains(e.target)) uRoleMenu.classList.add('hidden');

    const uBranchBtn = document.getElementById('userBranchBtn');
    const uBranchMenu = document.getElementById('userBranchOptions');
    if (uBranchBtn && uBranchMenu && !uBranchBtn.contains(e.target) && !uBranchMenu.contains(e.target)) uBranchMenu.classList.add('hidden');
});


// 1. Handle clicking the "Body" of the notification (Navigation)
function handleNotificationClick(itemName, branchName) {
    console.log(`Navigating to: ${itemName} (${branchName})`);
    closeAllDropdowns();

    // 1. Generate a Safe ID (Must match renderInventoryCards logic)
    // Remove all special characters/spaces to ensure a match
    const rawString = `${itemName}-${branchName || 'general'}`;
    const cleanId = rawString.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    // 2. Set global highlight target
    window.pendingHighlight = { id: cleanId };

    // 3. Navigate to Inventory
    showPage('inventory');

    // 4. Reset Branch Filter so the item isn't hidden
    const branchSelect = document.getElementById('branchFilter');
    if (branchSelect) {
        branchSelect.value = 'All'; // Force to 'All' to ensure visibility
        document.getElementById('branchLabel').textContent = 'All branches';
    }

    // 5. Refresh inventory (This will trigger the highlight in renderInventoryCards)
    fetchInventory();
}
function handleLocalAcknowledge(type, id) {
    // 1. Visual Feedback
    showToast("Alert Acknowledged");

    // 2. SAVE TO LOCAL STORAGE (Persistence)
    // We store the ID in a list of "dismissed" items so it doesn't come back on refresh
    const dismissed = JSON.parse(localStorage.getItem('premierlux_dismissed') || '[]');
    if (!dismissed.includes(id)) {
        dismissed.push(id);
        localStorage.setItem('premierlux_dismissed', JSON.stringify(dismissed));
    }

    // 3. Remove from local state immediately (Optimistic UI)
    if (type === 'stock') {
        window.bellState.lowStockItems = window.bellState.lowStockItems.filter(i => i.name !== id);
    } else if (type === 'expiry') {
        window.bellState.expiringItems = window.bellState.expiringItems.filter(i => {
            const iId = i.id || i._id || i.batch_number || 'unknown';
            return iId !== id;
        });
    }

    // 4. Re-render
    renderSharedBell();
}

// 3. Fetch System Alerts (from Backend)
function fetchAlertsForBell() {
    fetch(ALERTS_API_URL)
        .then(res => res.json())
        .then(alerts => {
            if (window.updateApiAlerts) window.updateApiAlerts(alerts);
            renderSharedBell(); // Render after fetching
        })
        .catch(err => console.error('Error fetching alerts', err));
}

// 4. Render the Dropdown Content (Desktop & Mobile)
function renderSharedBell() {
    const alertBadge = document.getElementById('alertsBadge');

    // Target BOTH lists
    const desktopList = document.getElementById('alertsDropdownList');
    const mobileList = document.getElementById('mobileAlertsList');

    // Counts
    const lowCount = window.bellState.lowStockItems.length;
    const expCount = window.bellState.expiringItems.length;
    const apiCount = window.bellState.apiAlerts.length;
    const totalAlerts = lowCount + expCount + apiCount;

    // Update Red Badge (Desktop Icon)
    if (alertBadge) {
        alertBadge.textContent = totalAlerts > 9 ? '9+' : totalAlerts;
        if (totalAlerts > 0) {
            alertBadge.classList.remove('hidden');
            alertBadge.classList.add('animate-pulse');
        } else {
            alertBadge.classList.add('hidden');
        }
    }

    // Helper to clear and set content for both lists
    const setContent = (html) => {
        if (desktopList) desktopList.innerHTML = html;
        if (mobileList) mobileList.innerHTML = html;
    };

    const appendContent = (html) => {
        if (desktopList) desktopList.innerHTML += html;
        if (mobileList) mobileList.innerHTML += html;
    };

    // 1. Handle Empty State
    if (totalAlerts === 0) {
        setContent(`
            <div class="flex flex-col items-center justify-center py-4 text-slate-500 opacity-60">
                <span class="text-xl">🎉</span>
                <span class="text-[10px] mt-1">All caught up!</span>
            </div>
        `);
        return;
    }

    // Clear lists before adding new items
    if (desktopList) desktopList.innerHTML = '';
    if (mobileList) mobileList.innerHTML = '';

    // --- ROW CREATOR HELPER ---
    const createNotificationRow = (type, branch, item, detail, colorClass, btnCallback) => {
        const safeItem = (item || 'Unknown Item').toString().replace(/'/g, "\\'");
        const safeBranch = (branch || 'General').toString().replace(/'/g, "\\'");

        return `
        <div class="group mb-2 bg-slate-800/50 hover:bg-slate-800 border border-white/5 rounded-xl overflow-hidden transition-all duration-200">
            <div class="flex items-center justify-between px-3 py-2 bg-white/5 border-b border-white/5">
                <div class="flex items-center gap-2 overflow-hidden">
                    <span class="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md ${colorClass}">
                        ${type}
                    </span>
                    <span class="text-[10px] text-slate-400 font-medium truncate max-w-[100px]" title="${branch}">
                        ${branch || 'General'}
                    </span>
                </div>
                <button onclick="${btnCallback}; event.stopPropagation();" 
                    class="text-slate-500 hover:text-emerald-400 transition-colors p-1 rounded-full hover:bg-white/10" 
                    title="Acknowledge">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5"></path></svg>
                </button>
            </div>
            <div onclick="handleNotificationClick('${safeItem}', '${safeBranch}'); toggleMobileMenu();" 
                 class="px-3 py-2 cursor-pointer hover:bg-white/5 transition">
                <div class="flex justify-between items-center">
                    <span class="text-sm font-semibold text-slate-200">${item || 'Unknown Item'}</span>
                    <span class="text-[10px] text-slate-400 font-mono">${detail}</span>
                </div>
            </div>
        </div>`;
    };

    // A. Expiring Items
    window.bellState.expiringItems.forEach(item => {
        const daysLeft = item.daysLeft;
        const isExpired = daysLeft < 0;
        const badgeText = isExpired ? "Expired" : "Expiring";
        const detailText = isExpired ? `Expired ${Math.abs(daysLeft)} days ago` : `${daysLeft} days left`;
        const badgeColor = isExpired ? "bg-red-500/20 text-red-400" : "bg-orange-500/20 text-orange-400";
        const itemId = item.id || item._id || item.batch_number || 'unknown';

        appendContent(createNotificationRow(
            badgeText, item.branch, item.item_name, detailText, badgeColor,
            `handleLocalAcknowledge('expiry', '${itemId}')`
        ));
    });

    // B. Low Stock Items
    window.bellState.lowStockItems.forEach(item => {
        appendContent(createNotificationRow(
            "Low Stock", item.branch, item.name, `${item.quantity} units left`,
            "bg-rose-500/20 text-rose-400",
            `handleLocalAcknowledge('stock', '${item.name}')`
        ));
    });

    // C. System Alerts
    window.bellState.apiAlerts.forEach(alert => {
        appendContent(createNotificationRow(
            "System", "Admin", alert.title, "Action required",
            "bg-emerald-500/20 text-emerald-400",
            `acknowledgeAlert('${alert.id}')`
        ));
    });
}

window.updateLowStock = function (data) {
    if (!data) return;

    // Get dismissed IDs
    const dismissed = JSON.parse(localStorage.getItem('premierlux_dismissed') || '[]');

    window.bellState.lowStockItems = data.filter(i => {
        const isLow = (i.quantity || 0) <= (i.reorder_level || 0);
        const isDismissed = dismissed.includes(i.name);
        return isLow && !isDismissed; // Only show if Low AND Not Dismissed
    });

    renderSharedBell();
};

window.updateApiAlerts = function (alerts) {
    if (!alerts) return;
    window.bellState.apiAlerts = alerts.filter(a => a.type !== 'low_stock' && a.type !== 'expiry_risk');
    renderSharedBell();
};

window.updateExpiryAndBell = function (batchData) {
    if (!batchData || !Array.isArray(batchData)) return;

    const today = new Date();
    const dismissed = JSON.parse(localStorage.getItem('premierlux_dismissed') || '[]');

    window.bellState.expiringItems = [];

    batchData.forEach(item => {
        const dateString = item.exp_date || item.expiration_date;
        if (dateString) {
            const expDate = new Date(dateString);
            if (!isNaN(expDate)) {
                const diffTime = expDate - today;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

                // Identify the item uniquely
                const itemId = item.id || item._id || item.batch_number || 'unknown';

                // Check if expiring (<= 30 days) AND Not Dismissed
                if (diffDays <= 30 && !dismissed.includes(itemId)) {
                    window.bellState.expiringItems.push({ ...item, daysLeft: diffDays });
                }
            }
        }
    });

    // Update KPI Card
    const dashExpiringEl = document.getElementById('dash-expiring');
    if (dashExpiringEl) {
        dashExpiringEl.textContent = window.bellState.expiringItems.length;
    }

    renderSharedBell();
};

function fetchBatchesForAlerts() {
    fetch(`${API_BASE}/api/batches`)
        .then(r => r.json())
        .then(data => { if (window.updateExpiryAndBell) window.updateExpiryAndBell(data); });
}


// ==========================================
// 6. ADD BATCH MODAL
// ==========================================

function openBatchOverlay() {
    const overlay = document.getElementById('batchOverlay');
    if (overlay) overlay.classList.remove('hidden');
    // Sync logic
    fetchBranches(branches => {
        if (typeof updateBranchSelect === 'function') updateBranchSelect(branches);
        updateBatchBranchSelect(branches);
    });
}

function closeBatchOverlay() {
    document.getElementById('batchOverlay').classList.add('hidden');
}

// Custom Glass Dropdown for Batch Modal
function updateBatchBranchSelect(branches) {
    const container = document.getElementById('batchBranchOptions');
    if (!container) return;
    container.innerHTML = '';
    branches.forEach(b => {
        container.innerHTML += `
            <button type="button" onclick="selectBatchBranch('${b.name}')" 
                class="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 transition">
                ${b.name}
            </button>`;
    });
}

function toggleBatchBranchMenu() {
    const menu = document.getElementById('batchBranchOptions');
    if (menu) menu.classList.toggle('hidden');
}

function selectBatchBranch(branchName) {
    document.getElementById('batch_branch').value = branchName;
    const label = document.getElementById('batchBranchLabel');
    if (label) {
        label.textContent = branchName;
        label.classList.remove('text-slate-400');
        label.classList.add('text-slate-800');
    }
    document.getElementById('batchBranchOptions').classList.add('hidden');
}

async function submitBatchForm(e) {
    e.preventDefault();

    // 1. Grab values specifically
    const branchValue = document.getElementById('batch_branch').value;
    const itemName = document.getElementById('batch_item_name').value;

    // 2. Validate Frontend Side First
    if (!branchValue) {
        alert("Please select a branch first.");
        return;
    }
    if (!itemName) {
        alert("Item name is required.");
        return;
    }

    // 3. Construct Payload (Ensure keys match what Python expects)
    const payload = {
        item_name: itemName,
        branch: branchValue, // <--- Crucial Fix
        sku: document.getElementById('batch_sku').value,
        monthly_usage: Number(document.getElementById('batch_monthly_usage').value),
        current_stock: Number(document.getElementById('batch_current_stock').value),
        reorder_level: Number(document.getElementById('batch_reorder_level').value),
        price: Number(document.getElementById('batch_price').value),
        batch_number: document.getElementById('batch_batch_number').value,
        lot_number: document.getElementById('batch_lot_number').value,
        mfg_date: document.getElementById('batch_mfg_date').value,
        exp_date: document.getElementById('batch_exp_date').value,
        supplier_batch: document.getElementById('batch_supplier_batch').value,
        qr_code_id: document.getElementById('batch_qr_code_id').value,
        category: document.getElementById('itemCategory').value
    };

    try {
        const res = await fetch(`${API_BASE}/api/batches`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || "Failed to add batch");
        }

        showToast('Batch successfully added!');
        closeBatchOverlay();

        // Refresh Data
        fetchInventory();
        fetchBatchesForAlerts();
        if (typeof initDashboard === 'function') initDashboard();

        // Reset Form
        document.getElementById('batchForm').reset();
        document.getElementById('batchBranchLabel').textContent = "Select branch...";
        document.getElementById('batch_branch').value = "";

    } catch (err) {
        console.error(err);
        alert(err.message);
    }
}


// --- BATCH CATEGORY DROPDOWN ---
function toggleBatchCategoryMenu() {
    const menu = document.getElementById('batchCategoryOptions');
    // Close branch menu if open
    document.getElementById('batchBranchOptions').classList.add('hidden');
    if (menu) menu.classList.toggle('hidden');
}

function selectBatchCategory(value) {
    document.getElementById('itemCategory').value = value;
    document.getElementById('batchCategoryLabel').textContent = value;
    document.getElementById('batchCategoryOptions').classList.add('hidden');
}

// --- EDIT STOCK ACTION DROPDOWN ---
function toggleEditActionMenu() {
    const menu = document.getElementById('editActionOptions');
    document.getElementById('editReasonOptions').classList.add('hidden');
    if (menu) menu.classList.toggle('hidden');
}

function selectEditAction(value, label) {
    document.getElementById('edit_action').value = value;
    document.getElementById('editActionLabel').textContent = label;
    document.getElementById('editActionOptions').classList.add('hidden');
}

// --- EDIT STOCK REASON DROPDOWN ---
function toggleEditReasonMenu() {
    const menu = document.getElementById('editReasonOptions');
    document.getElementById('editActionOptions').classList.add('hidden');
    if (menu) menu.classList.toggle('hidden');
}

function selectEditReason(value, label) {
    document.getElementById('edit_reason_cat').value = value;
    document.getElementById('editReasonLabel').textContent = label;
    document.getElementById('editReasonOptions').classList.add('hidden');
}


// ==========================================
// 7. RESTOCK / ORDERS MODAL
// ==========================================

async function openRestockModal(itemName, branchName, currentQty) {
    const modal = document.getElementById('restockOverlay');
    if (!modal) return;

    document.getElementById('restock_item_name').textContent = itemName;
    document.getElementById('restock_branch').textContent = branchName;
    document.getElementById('restock_current').value = currentQty;
    document.getElementById('restock_qty').value = '';
    document.getElementById('restock_supplier').value = '';
    document.getElementById('restockSupplierLabel').textContent = 'Select Supplier...';

    try {
        const res = await fetch(SUPPLIERS_API_URL);
        const suppliers = await res.json();
        updateRestockSupplierSelect(suppliers);
    } catch (err) {
        console.error(err);
    }
    modal.classList.remove('hidden');
}

function updateRestockSupplierSelect(suppliers) {
    const container = document.getElementById('restockSupplierOptions');
    if (!container) return;
    container.innerHTML = '';
    if (suppliers.length === 0) container.innerHTML = `<div class="p-2 text-xs text-slate-400">No suppliers found.</div>`;
    else suppliers.forEach(s => {
        container.innerHTML += `
            <button type="button" onclick="selectRestockSupplier('${s.name}')" 
                class="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 transition flex justify-between items-center">
                <span>${s.name}</span><span class="text-[10px] text-slate-400">${s.lead_time_days || '?'} days</span>
            </button>`;
    });
}

function toggleRestockSupplierMenu() {
    document.getElementById('restockSupplierOptions').classList.toggle('hidden');
}

function selectRestockSupplier(name) {
    document.getElementById('restock_supplier').value = name;
    document.getElementById('restockSupplierLabel').textContent = name;
    document.getElementById('restockSupplierOptions').classList.add('hidden');
}

function closeRestockModal() {
    document.getElementById('restockOverlay').classList.add('hidden');
}

function handleRestockOutsideClick(e) {
    if (e.target.id === 'restockOverlay') closeRestockModal();
}

async function submitRestockRequest(e) {
    e.preventDefault();
    const payload = {
        item: document.getElementById('restock_item_name').textContent,
        branch: document.getElementById('restock_branch').textContent,
        quantity: parseInt(document.getElementById('restock_qty').value),
        supplier: document.getElementById('restock_supplier').value,
        priority: document.querySelector('input[name="priority"]:checked').value,
        notes: document.getElementById('restock_notes').value,
        status: 'pending',
        created_at: new Date().toISOString()
    };

    const btn = e.target.querySelector('button[type="submit"]');
    btn.textContent = "Sending...";
    btn.disabled = true;

    try {
        const res = await fetch(ORDERS_API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (!res.ok) throw new Error("Failed");
        closeRestockModal();
        showToast("Order sent!");
        if (!document.getElementById('orders-section').classList.contains('hidden')) fetchOrders();
    } catch (err) {
        alert(err.message);
    } finally {
        btn.textContent = "Submit Request";
        btn.disabled = false;
    }
}


// ==========================================
// 8. SUPPLIERS & ORDERS (Updated)
// ==========================================

async function fetchSuppliers() {
    try {
        const res = await fetch(SUPPLIERS_API_URL);
        const data = await res.json();
        renderSupplierCards(data);
    } catch (e) { console.error("Fetch Error:", e); }
}

function renderSupplierCards(suppliers) {
    const grid = document.getElementById('suppliersGrid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!suppliers || suppliers.length === 0) {
        grid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400">No suppliers found.</div>`;
        return;
    }

    suppliers.forEach(s => {
        const initial = s.name.charAt(0).toUpperCase();
        const safeName = s.name.replace(/'/g, "\\'");
        const safeContact = (s.contact || '').replace(/'/g, "\\'");
        const safePhone = (s.phone || '').replace(/'/g, "\\'");
        const safeWebsite = (s.website || '').replace(/'/g, "\\'");
        // Store notes but replace newlines for safe passing
        const safeNotes = (s.notes || '').replace(/'/g, "\\'").replace(/\n/g, "\\n");

        // Logic: Is this an online shop? (Has website but no phone, or just has website)
        let contactDisplay = '';
        if (s.phone) {
            contactDisplay = `<a href="tel:${s.phone}" class="text-sm font-semibold text-emerald-600 hover:underline truncate block">📞 ${s.phone}</a>`;
        } else if (s.website) {
            contactDisplay = `<a href="${s.website}" target="_blank" class="text-sm font-semibold text-emerald-600 hover:underline truncate block">🌐 Visit Shop</a>`;
        } else {
            contactDisplay = `<span class="text-sm font-semibold text-slate-400">-</span>`;
        }

        // Show notes if they exist
        const notesSection = s.notes ?
            `<div class="mt-3 text-xs text-slate-500 bg-slate-50 p-2 rounded-lg border border-slate-100 italic">"${s.notes}"</div>`
            : '';

        grid.innerHTML += `
<div class="bg-white border border-slate-100 rounded-2xl p-5 shadow-md hover:shadow-lg transition-all duration-200 group relative flex flex-col h-full">
            <div class="flex items-start justify-between mb-4">
                <div class="flex items-center gap-3">
                    <div class="h-12 w-12 rounded-xl bg-gradient-to-br from-blue-500 to-cyan-400 flex items-center justify-center text-white text-lg font-bold shadow-sm flex-shrink-0">
                        ${initial}
                    </div>
                    <div class="overflow-hidden">
                        <h3 class="font-bold text-slate-800 text-base truncate" title="${s.name}">${s.name}</h3>
                        <p class="text-xs text-slate-500 truncate">${s.contact || 'No contact person'}</p>
                    </div>
                </div>
                <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onclick="openEditSupplier('${safeName}', '${safeContact}', '${safePhone}', ${s.lead_time_days}, '${safeWebsite}', '${safeNotes}')" 
                        class="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition" title="Edit">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"></path></svg>
                    </button>
                    <button onclick="deleteSupplier('${safeName}')" 
                        class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
                    </button>
                </div>
            </div>

            <div class="grid grid-cols-2 gap-3 mb-2">
                <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                    <span class="block text-[10px] text-slate-400 uppercase font-bold mb-0.5">Lead Time</span>
                    <span class="text-sm font-semibold text-slate-700">${s.lead_time_days || '-'} Days</span>
                </div>
                <div class="bg-slate-50 p-2.5 rounded-xl border border-slate-100">
                    <span class="block text-[10px] text-slate-400 uppercase font-bold mb-0.5">${s.website ? 'Link / Contact' : 'Contact'}</span>
                    ${contactDisplay}
                </div>
            </div>

            ${notesSection}
            
            <div class="mt-auto pt-4">
                <button onclick="openRestockFromSupplier('${safeName}')" class="w-full py-2 rounded-xl bg-white border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 hover:text-slate-800 transition">
                    Create Purchase Order
                </button>
            </div>
        </div>`;
    });
}

// --- MODAL LOGIC (Updated for New Fields) ---

function openEditSupplier(name, contact, phone, lead, website, notes) {
    currentEditSupplier = name;

    // UI Updates
    document.getElementById('supplierModalTitle').textContent = "Edit Supplier";
    document.getElementById('supplierSubmitBtn').textContent = "Save Changes";

    // Fill Fields
    document.getElementById('new_supp_name').value = name;
    document.getElementById('new_supp_name').disabled = true;

    document.getElementById('new_supp_contact').value = (contact && contact !== 'undefined') ? contact : '';
    document.getElementById('new_supp_phone').value = (phone && phone !== 'undefined') ? phone : '';
    document.getElementById('new_supp_lead').value = lead || 0;
    document.getElementById('new_supp_website').value = (website && website !== 'undefined') ? website : '';

    // Notes needs newlines restored if we escaped them
    document.getElementById('new_supp_notes').value = (notes && notes !== 'undefined') ? notes.replace(/\\n/g, "\n") : '';

    document.getElementById('supplierOverlay').classList.remove('hidden');
}

function openSupplierModal() {
    currentEditSupplier = null;

    document.getElementById('supplierModalTitle').textContent = "New Supplier";
    document.getElementById('supplierSubmitBtn').textContent = "Add Supplier";

    document.getElementById('new_supp_name').disabled = false;
    document.getElementById('new_supp_name').value = '';
    document.getElementById('new_supp_contact').value = '';
    document.getElementById('new_supp_phone').value = '';
    document.getElementById('new_supp_lead').value = '';
    document.getElementById('new_supp_website').value = '';
    document.getElementById('new_supp_notes').value = '';

    document.getElementById('supplierOverlay').classList.remove('hidden');
}

function closeSupplierModal() {
    const overlay = document.getElementById('supplierOverlay');
    if (overlay) overlay.classList.add('hidden');
}

function handleSupplierOutsideClick(e) {
    if (e.target.id === 'supplierOverlay') closeSupplierModal();
}

async function submitSupplierForm(e) {
    e.preventDefault();
    const payload = {
        name: document.getElementById('new_supp_name').value,
        contact: document.getElementById('new_supp_contact').value,
        phone: document.getElementById('new_supp_phone').value,
        lead_time_days: Number(document.getElementById('new_supp_lead').value),
        website: document.getElementById('new_supp_website').value,
        notes: document.getElementById('new_supp_notes').value
    };

    try {
        let url = SUPPLIERS_API_URL;
        let method = 'POST';

        if (currentEditSupplier) {
            url = `${SUPPLIERS_API_URL}/${encodeURIComponent(currentEditSupplier)}`;
            method = 'PUT';
        }

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Failed");

        closeSupplierModal();
        fetchSuppliers();
        showToast(currentEditSupplier ? "Supplier updated" : "Supplier saved");

    } catch (err) { alert(err.message); }
}

function deleteSupplier(name) {
    openDeleteModal('supplier', name);
}

// EDIT LOGIC
let currentEditSupplier = null;

function openEditSupplier(name, contact, phone, lead) {
    currentEditSupplier = name; // Save name to identify who we are editing

    // Pre-fill the "Add Supplier" modal but change the title/button
    document.getElementById('supplierModalTitle').textContent = "Edit Supplier";
    document.getElementById('supplierSubmitBtn').textContent = "Save Changes";

    document.getElementById('new_supp_name').value = name;
    document.getElementById('new_supp_name').disabled = true; // Cannot change name (it's the ID)
    document.getElementById('new_supp_contact').value = contact !== 'undefined' ? contact : '';
    document.getElementById('new_supp_phone').value = phone !== 'undefined' ? phone : '';
    document.getElementById('new_supp_lead').value = lead || 0;

    document.getElementById('supplierOverlay').classList.remove('hidden');
}

function openSupplierModal() {
    // Reset to "Add Mode"
    currentEditSupplier = null;
    document.getElementById('supplierModalTitle').textContent = "New Supplier";
    document.getElementById('supplierSubmitBtn').textContent = "Add Supplier";
    document.getElementById('new_supp_name').disabled = false;
    document.getElementById('new_supp_name').value = '';
    document.getElementById('new_supp_contact').value = '';
    document.getElementById('new_supp_phone').value = '';
    document.getElementById('new_supp_lead').value = '';

    document.getElementById('supplierOverlay').classList.remove('hidden');
}

// Updated Submit Function to handle BOTH Add and Edit
async function submitSupplierForm(e) {
    e.preventDefault();
    const payload = {
        name: document.getElementById('new_supp_name').value,
        contact: document.getElementById('new_supp_contact').value,
        phone: document.getElementById('new_supp_phone').value,
        lead_time_days: Number(document.getElementById('new_supp_lead').value)
    };

    try {
        let url = SUPPLIERS_API_URL;
        let method = 'POST';

        // If we are editing, change URL and Method
        if (currentEditSupplier) {
            url = `${SUPPLIERS_API_URL}/${encodeURIComponent(currentEditSupplier)}`;
            method = 'PUT';
        }

        const res = await fetch(url, {
            method: method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Failed");

        closeSupplierModal();
        fetchSuppliers();
        showToast(currentEditSupplier ? "Supplier updated" : "Supplier saved");

    } catch (err) { alert(err.message); }
}


// Add this helper function
function handleSupplierOutsideClick(e) {
    if (e.target.id === 'supplierOverlay') {
        closeSupplierModal();
    }
}

// Quick Helper to start an order
function openRestockFromSupplier(supplierName) {
    showPage('dashboard');
    openRestockModal('', '', 0); // Open generic
    // Pre-select supplier logic would go here if we enhance restock modal further
    setTimeout(() => {
        const select = document.getElementById('restock_supplier');
        if (select) select.value = supplierName;
        document.getElementById('restockSupplierLabel').textContent = supplierName;
    }, 500);
}

async function fetchOrders() {
    try {
        const res = await fetch(ORDERS_API_URL);
        if (res.ok) renderOrdersTable(await res.json());
    } catch (e) { }
}

function renderOrdersTable(orders) {
    const tbody = document.getElementById('ordersTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    if (!orders || orders.length === 0) { tbody.innerHTML = `<tr><td colspan="6" class="text-center py-8 text-slate-400">No orders.</td></tr>`; return; }

    orders.forEach(o => {
        let badge = o.status === 'pending'
            ? `<span class="px-2 py-1 rounded-md bg-amber-50 text-amber-600 text-xs font-bold border border-amber-100">Pending</span>`
            : `<span class="px-2 py-1 rounded-md bg-emerald-50 text-emerald-600 text-xs font-bold border border-emerald-100">Received</span>`;

        tbody.innerHTML += `
        <tr class="hover:bg-slate-50/50 transition">
            <td class="px-6 py-4 font-mono text-xs text-slate-500">#PO-${(o._id || o.id || '???').slice(-4)}</td>
            <td class="px-6 py-4"><div class="font-bold text-slate-700">${o.item}</div><div class="text-xs text-slate-400">Qty: ${o.quantity}</div></td>
            <td class="px-6 py-4 text-xs text-slate-600">${o.branch}</td>
            <td class="px-6 py-4">${badge}</td>
            <td class="px-6 py-4 text-xs text-slate-500">${new Date(o.created_at).toLocaleDateString()}</td>
            <td class="px-6 py-4 text-center">
                ${o.status === 'pending' ? `<button onclick="showToast('Order received logic needed')" class="text-xs bg-slate-900 text-white px-3 py-1.5 rounded-lg">Receive</button>` : `<span class="text-xs text-emerald-600 font-medium">✓ Done</span>`}
            </td>
        </tr>`;
    });
}

// ==========================================
// 9. BRANCHES MANAGEMENT (FIXED)
// ==========================================

function fetchBranches(callback = null) { // ➤ Added 'callback' parameter
    const grid = document.getElementById('branchesGrid');
    const search = document.getElementById('branchSearch')?.value.toLowerCase() || '';

    // Simple Loading State for the management grid
    if (grid) grid.innerHTML = '<div class="col-span-full text-center py-10"><i class="fas fa-circle-notch fa-spin text-brand-600 text-2xl"></i></div>';

    fetch(BRANCHES_API_URL)
        .then(res => res.json())
        .then(data => {
            // 1. Run the management grid logic
            if (grid) {
                grid.innerHTML = '';
                const filtered = data.filter(b =>
                    b.name.toLowerCase().includes(search) ||
                    (b.manager && b.manager.toLowerCase().includes(search))
                );

                if (filtered.length === 0) {
                    grid.innerHTML = `<div class="col-span-full text-center text-slate-400 py-10">No branches found.</div>`;
                } else {
                    filtered.forEach(branch => {
                        const branchId = branch.id || branch._id || '';
                        const card = document.createElement('div');
                        card.className = "bg-white border border-slate-200 rounded-3xl p-6 shadow-md hover:shadow-lg transition-all duration-300 group relative flex flex-col";

                        const safeName = branch.name.replace(/'/g, "\\'");
                        const safeAddr = (branch.address || 'No Address').replace(/'/g, "\\'");
                        const safeMgr = (branch.manager || 'Unassigned').replace(/'/g, "\\'");
                        const safePhone = (branch.phone || 'No Contact').replace(/'/g, "\\'");

                        card.innerHTML = `
                            <div class="flex justify-between items-start mb-4">
                                <div class="h-12 w-12 rounded-2xl bg-brand-50 text-brand-600 flex items-center justify-center text-xl shadow-sm">🏢</div>
                            </div>
                            <h3 class="text-xl font-extrabold text-brand-900 mb-1">${branch.name}</h3>
                            <div class="mt-auto grid grid-cols-2 gap-3">
                                <button onclick="filterInventoryByBranch('${safeName}')" class="col-span-2 py-2.5 rounded-xl bg-brand-600 text-white text-xs font-bold hover:bg-brand-700 shadow-md transition flex items-center justify-center gap-2">View Stock</button>
                                <button onclick="openBranchModal('${branchId}', '${safeName}', '${safeAddr}', '${safeMgr}', '${safePhone}')" class="py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-bold hover:bg-slate-50 transition">Edit</button>
                                <button onclick="deleteBranch('${branchId}')" class="py-2 rounded-xl border border-rose-100 text-rose-500 text-xs font-bold hover:bg-rose-50 transition">Delete</button>
                            </div>`;
                        grid.appendChild(card);
                    });
                }
            }

            // ➤ 2. CRITICAL FIX: Run the callback if provided (this fills the dropdowns)
            if (typeof callback === 'function') {
                callback(data);
            }
        })
        .catch(err => console.error(err));
}

// --- BRANCH ACTIONS ---

// 1. Open Modal (Handles both Add & Edit)
function openBranchModal(id = null, name = '', address = '', manager = '', phone = '') {
    const modal = document.getElementById('branchOverlay');
    const title = document.getElementById('branchModalTitle');

    // Set Fields
    document.getElementById('branch_id').value = id || '';
    document.getElementById('new_branch_name').value = name;
    document.getElementById('new_branch_address').value = address;
    document.getElementById('new_branch_manager').value = manager;
    document.getElementById('new_branch_phone').value = phone;

    // Update Title
    title.textContent = id ? "Edit Branch" : "Add Branch";

    modal.classList.remove('hidden');
}

function closeBranchModal() {
    document.getElementById('branchOverlay').classList.add('hidden');
}

function handleBranchOutsideClick(e) {
    if (e.target.id === 'branchOverlay') closeBranchModal();
}

function submitBranchForm(e) {
    e.preventDefault();

    // ➤ FIX: Ensure we don't accidentally get the string "undefined"
    let id = document.getElementById('branch_id').value;
    if (id === 'undefined' || id === 'null') id = '';

    const name = document.getElementById('new_branch_name').value;
    const address = document.getElementById('new_branch_address').value;
    const manager = document.getElementById('new_branch_manager').value;
    const phone = document.getElementById('new_branch_phone').value;

    // Determine Logic (Create vs Update)
    const method = id ? 'PUT' : 'POST';
    const url = id ? `${BRANCHES_API_URL}/${id}` : BRANCHES_API_URL;

    fetch(url, {
        method: method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, address, manager, phone })
    })
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                alert(data.error);
            } else {
                showToast(id ? 'Branch updated!' : 'Branch created!');
                closeBranchModal();
                fetchBranches();
                // Also refresh dropdowns if needed
                if (typeof fetchBranchDropdown === 'function') fetchBranchDropdown();
            }
        })
        .catch(err => console.error(err));
}

// 3. Delete Branch
function deleteBranch(id) {
    if (!confirm("Are you sure? This will delete the branch and all associated stock data.")) return;

    fetch(`${BRANCHES_API_URL}/${id}`, { method: 'DELETE' })
        .then(res => res.json())
        .then(data => {
            if (data.error) alert(data.error);
            else {
                showToast('Branch deleted');
                fetchBranches();
            }
        });
}

// 4. View Stock Integration (Smart Redirect)
function filterInventoryByBranch(branchName) {
    // 1. Switch to Inventory Page
    showPage('inventory');

    // 2. Set the dropdown value
    const dropdown = document.getElementById('branchFilter');
    const label = document.getElementById('branchLabel');

    if (dropdown) {
        dropdown.value = branchName;
        label.textContent = branchName;
    }

    // 3. Trigger fetch
    fetchInventory();
}

async function saveBranch() {
    const name = document.getElementById('branchName').value.trim();
    if (!name) return alert('Name required');
    await fetch(BRANCHES_API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
            name, address: document.getElementById('branchAddress').value, manager: document.getElementById('branchManager').value
        })
    });
    document.getElementById('branchName').value = '';
    fetchBranches();
    initDashboard(); // Update KPI
}

let editContext = {};
function openEditStockModal(name, branch, currentQty) {
    editContext = { name, branch, current: currentQty };
    document.getElementById('edit_item_name').textContent = name;
    document.getElementById('edit_item_branch').textContent = branch;
    document.getElementById('edit_current_stock').textContent = currentQty;
    document.getElementById('editStockOverlay').classList.remove('hidden');
}
function closeEditStockModal() { document.getElementById('editStockOverlay').classList.add('hidden'); }

async function submitEditStock() {
    const qty = Number(document.getElementById('edit_quantity').value);
    const action = document.getElementById('edit_action').value;
    const reasonCat = document.getElementById('edit_reason_cat').value;
    const note = document.getElementById('edit_note').value;

    // Calculate delta
    let delta = 0;
    if (action === 'out') delta = -qty;
    else if (action === 'in') delta = qty;
    else if (action === 'set') delta = qty - editContext.current;

    try {
        await fetch(`${API_URL}/${encodeURIComponent(editContext.name)}/adjust`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                branch: editContext.branch,
                delta: delta,
                reason_category: reasonCat, // <--- Sending it
                note: note
            })
        });

        closeEditStockModal();
        fetchInventory();
        initDashboard();
        showToast("Stock updated & logged");
    } catch (e) {
        console.error(e);
        alert("Failed to adjust stock");
    }
}
// AI Functions (Keep existing ones)
async function loadAiDashboard() {
    try {
        const res = await fetch(`${API_BASE}/api/ai/dashboard`);
        if (res.ok) applyAiDashboardToCards(await res.json());
    } catch (e) { }
}
function applyAiDashboardToCards(data) {
    if (document.getElementById("aiSummaryText")) document.getElementById("aiSummaryText").textContent = data.summary_text || "No AI data.";
    if (document.getElementById("aiRiskText")) document.getElementById("aiRiskText").textContent = data.risk_text || "No risk data.";
}

// ==========================================
// ITEM DETAILS MODAL LOGIC (Complete)
// ==========================================

function openItemDetails(item) {
    const modal = document.getElementById('itemDetailsOverlay');
    if (!modal) return;

    // Helper to safely set text, defaulting to '-' if missing
    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = (val !== null && val !== undefined && val !== '') ? val : '-';
    };

    // 1. Basic Info
    setText('detail_name', item.name);
    setText('detail_branch', item.branch);
    setText('detail_quantity', item.quantity);
    setText('detail_sku', item.sku);
    setText('detail_category', item.category);

    // 2. Financials & Metrics
    setText('detail_reorder', item.reorder_level);
    setText('detail_usage', item.monthly_usage);

    // Format Price nicely (e.g., ₱500.00)
    const priceEl = document.getElementById('detail_price');
    if (priceEl) {
        priceEl.textContent = item.price
            ? `₱${Number(item.price).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`
            : '-';
    }

    // 3. Batch Specifics (With Fallbacks)
    setText('detail_batch', item.batch_number || item.batch || 'N/A');
    setText('detail_lot', item.lot_number || 'N/A');
    setText('detail_supplier_batch', item.supplier_batch || 'N/A');

    // 4. Dates (Format nicely)
    const formatDate = (dateStr) => {
        if (!dateStr) return '-';
        // Handle Python string dates (YYYY-MM-DD) vs ISO
        const d = new Date(dateStr);
        return isNaN(d.getTime()) ? dateStr : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    };
    setText('detail_mfg', formatDate(item.mfg_date));
    setText('detail_exp', formatDate(item.exp_date || item.expiry_date));

    // QR Code Field
    const qrEl = document.getElementById('detail_qr');
    if (qrEl) qrEl.textContent = item.qr_code_id || item.id || '-';

    const qrId = item.qr_code_id || item.batch_number || item.id;
    generateDetailQR(qrId);

    // Show Modal
    modal.classList.remove('hidden');
}

function closeItemDetails() {
    const modal = document.getElementById('itemDetailsOverlay');
    if (modal) modal.classList.add('hidden');
}

function handleDetailsOutsideClick(e) {
    if (e.target.id === 'itemDetailsOverlay') {
        closeItemDetails();
    }
}

//TRANSITION AFTER LOGGING IN
function hideSplashScreen() {
    const splash = document.getElementById('splash-screen');
    if (splash) {
        // Add the fade-out class (triggering CSS transition)
        splash.classList.add('opacity-0', 'pointer-events-none');

        // Remove from DOM entirely after the transition (700ms)
        setTimeout(() => {
            splash.style.display = 'none';
        }, 700);
    }
}


// ==========================================
// 10. ANALYTICS PAGE LOGIC (Updated)
// ==========================================


function initAnalyticsOverview() {
    // 1. Fetch KPI Data (Overview)
    fetch(`${API_BASE}/analytics/overview`)
        .then(res => res.json())
        .then(d => {
            if (document.getElementById("an-new-items")) document.getElementById("an-new-items").textContent = d.new_items;
            if (document.getElementById("an-batches-7d")) document.getElementById("an-batches-7d").textContent = d.batches_7d;
            if (document.getElementById("an-total-items")) document.getElementById("an-total-items").textContent = d.total_items;
            if (document.getElementById("an-branches")) document.getElementById("an-branches").textContent = d.branches;
        })
        .catch(err => console.error("Analytics overview error", err));

    // 2. Fetch Lists
    fetchAnalyticsLists();

    // 3. Render Branch Tabs (Automated Navigation)
    renderAnalyticsTabs();

    // 4. Fetch Charts (Default: All)
    fetchAnalyticsCharts('All');
}

// NEW: Automates the Branch Tabs
async function renderAnalyticsTabs() {
    const container = document.getElementById('analyticsBranchTabs');
    if (!container) return;

    try {
        const res = await fetch(BRANCHES_API_URL);
        const branches = await res.json();

        // Start with "All Branches"
        let html = `
            <button onclick="switchAnalyticsBranch('All')" 
                class="analytics-tab px-4 py-2 rounded-full text-xs font-bold transition-all border whitespace-nowrap ${currentAnalyticsBranch === 'All' ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}">
                All Branches
            </button>`;

        // Loop through branches from DB
        branches.forEach(b => {
            const isActive = currentAnalyticsBranch === b.name;
            html += `
            <button onclick="switchAnalyticsBranch('${b.name}')" 
                class="analytics-tab px-4 py-2 rounded-full text-xs font-bold transition-all border whitespace-nowrap ${isActive ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'}">
                ${b.name}
            </button>`;
        });

        container.innerHTML = html;

    } catch (e) {
        container.innerHTML = `<span class="text-xs text-rose-400">Failed to load branches</span>`;
    }
}

// Handle Tab Switching
function switchAnalyticsBranch(branchName) {
    currentAnalyticsBranch = branchName;

    // Update UI (Highlight active tab)
    renderAnalyticsTabs();

    // Update Charts
    fetchAnalyticsCharts(branchName);
}

// Updated Chart Fetcher to accept Branch Name
async function fetchAnalyticsCharts(branchName = 'All') {
    try {
        console.log(`Fetching charts for: ${branchName}`);

        // Pass branch parameter to API
        const [weeklyRes, monthlyRes] = await Promise.all([
            fetch(`${API_BASE}/analytics/movement?branch=${encodeURIComponent(branchName)}`),
            fetch(`${API_BASE}/analytics/movement-monthly?branch=${encodeURIComponent(branchName)}`)
        ]);

        const weeklyData = await weeklyRes.json();
        const monthlyData = await monthlyRes.json();

        const payload = {
            movement: weeklyData,
            movement_monthly: monthlyData
        };

        lastAnalyticsPayload = payload;
        drawAnalytics(payload);

    } catch (err) {
        console.error("Failed to load charts:", err);
    }
}

// 2. Fetch Lists (Low Stock & Top Products)
function fetchAnalyticsLists() {
    // Low Stock Table
    fetch(`${API_BASE}/analytics/low-stock`)
        .then(res => res.json())
        .then(data => {
            const table = document.getElementById('lowStockTable');
            if (table) {
                table.innerHTML = "";
                if (!data || data.length === 0) {
                    table.innerHTML = `<tr><td colspan="3" class="px-6 py-8 text-center text-slate-400 text-xs">All stock levels healthy.</td></tr>`;
                } else {
                    data.forEach(p => {
                        table.innerHTML += `
                        <tr class="hover:bg-slate-50 transition">
                            <td class="px-6 py-3 font-medium text-slate-700">${p.name}</td>
                            <td class="px-6 py-3 font-bold text-slate-800 text-right">${p.quantity}</td>
                            <td class="px-6 py-3 text-right">
                                <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-100 text-rose-800">Low</span>
                            </td>
                        </tr>`;
                    });
                }
            }
        });

    // Top Products List
    fetch(`${API_BASE}/analytics/top-products`)
        .then(res => {
            if (!res.ok) throw new Error("Server Error");
            return res.json();
        })
        .then(data => {
            const list = document.getElementById('topProductsList');
            if (list) {
                list.innerHTML = "";
                if (!data || data.length === 0) {
                    list.innerHTML = `<li class="text-center text-slate-400 text-xs py-4">No consumption data yet.</li>`;
                } else {
                    data.forEach((p, index) => {
                        let rankClass = "bg-slate-100 text-slate-500";
                        let rankIcon = `#${index + 1}`;
                        if (index === 0) { rankClass = "bg-amber-100 text-amber-600"; rankIcon = "🥇"; }
                        if (index === 1) { rankClass = "bg-slate-200 text-slate-600"; rankIcon = "🥈"; }
                        if (index === 2) { rankClass = "bg-orange-100 text-orange-600"; rankIcon = "🥉"; }

                        // Safe Cost Calculation
                        const costVal = parseFloat(p.total_cost || 0);
                        const formattedCost = costVal.toLocaleString('en-PH', {
                            style: 'currency', currency: 'PHP', minimumFractionDigits: 2
                        });

                        list.innerHTML += `
                        <li class="flex items-center justify-between p-3 rounded-xl hover:bg-slate-50 transition border border-transparent hover:border-slate-100 group">
                            <div class="flex items-center gap-3">
                                <div class="w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${rankClass}">
                                    ${rankIcon}
                                </div>
                                <div>
                                    <div class="text-sm font-bold text-slate-700 truncate max-w-[140px]" title="${p._id}">${p._id}</div>
                                    <div class="h-1.5 w-24 bg-slate-100 rounded-full mt-1 overflow-hidden">
                                        <div class="h-full bg-indigo-500 rounded-full" style="width: ${Math.min(100, p.used * 2)}%"></div>
                                    </div>
                                </div>
                            </div>
                            <div class="text-right">
                                <span class="block text-xs font-bold text-indigo-600">${p.used} used</span>
                                <span class="block text-[10px] font-medium text-slate-400 mt-0.5">${formattedCost}</span>
                            </div>
                        </li>`;
                    });
                }
            }
        })
        .catch(err => {
            console.error("Top Products Error:", err);
            const list = document.getElementById('topProductsList');
            if (list) list.innerHTML = `<li class="text-center text-rose-400 text-xs py-4">Error loading data.</li>`;
        });
}

async function fetchAnalyticsCharts(branchName = 'All') { // Accept parameter
    try {
        console.log(`Fetching chart data for: ${branchName}...`);

        // Pass the branch to the API
        const [weeklyRes, monthlyRes] = await Promise.all([
            fetch(`${API_BASE}/analytics/movement?branch=${encodeURIComponent(branchName)}`),
            fetch(`${API_BASE}/analytics/movement-monthly?branch=${encodeURIComponent(branchName)}`)
        ]);

        const weeklyData = await weeklyRes.json();
        const monthlyData = await monthlyRes.json();

        const payload = {
            movement: weeklyData,
            movement_monthly: monthlyData
        };

        lastAnalyticsPayload = payload;
        drawAnalytics(payload);

    } catch (err) {
        console.error("Failed to load charts:", err);
    }
}

// 4. Draw Charts (Renderer)
function drawAnalytics(payload) {
    const section = document.getElementById('analytics-section');
    if (!section || section.classList.contains('hidden')) {
        lastAnalyticsPayload = payload;
        return;
    }

    // Update KPI Cards from Payload if available
    if (payload.overview) {
        const o = payload.overview;
        const updateText = (id, val) => {
            const el = document.getElementById(id);
            if (el) el.textContent = val;
        };
        updateText("an-new-items", o.new_items);
        updateText("an-batches-7d", o.batches_7d);
        updateText("an-total-items", o.total_items);
        updateText("an-branches", o.branches);
    }

    const lineCanvas = document.getElementById('analytics-main-chart');
    const barCanvas = document.getElementById('stockInOutChart');

    if (!lineCanvas || !barCanvas) return;

    const weekly = payload.movement || { labels: [], stock_in: [], stock_out: [] };
    const monthly = payload.movement_monthly || weekly;

    // A. Big Chart (Line)
    const lineCtx = lineCanvas.getContext('2d');
    if (analyticsMainChart) { analyticsMainChart.destroy(); analyticsMainChart = null; }

    analyticsMainChart = new Chart(lineCtx, {
        type: 'line',
        data: {
            labels: monthly.labels || [],
            datasets: [
                {
                    label: 'Stock In',
                    data: monthly.stock_in || [],
                    borderColor: '#5E4074',
                    pointBorderColor: '#5E4074',
                    pointBackgroundColor: '#fff',
                    backgroundColor: 'rgba(94, 64, 116, 0.1)',
                    pointRadius: 4
                },
                {
                    label: 'Stock Out',
                    data: monthly.stock_out || [],
                    borderColor: '#f43f5e',
                    backgroundColor: 'rgba(244, 63, 94, 0.1)',
                    tension: 0.3,
                    fill: true,
                    pointBackgroundColor: '#fff',
                    pointBorderColor: '#f43f5e',
                    pointRadius: 4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    padding: 12,
                    cornerRadius: 8,
                    displayColors: true
                }
            },
            scales: {
                y: { beginAtZero: true, grid: { color: '#f1f5f9', borderDash: [5, 5] }, ticks: { font: { size: 10 } } },
                x: { grid: { display: false }, ticks: { font: { size: 10 } } }
            }
        }
    });

    // B. Small Chart (Bar)
    const barCtx = barCanvas.getContext('2d');
    if (stockInOutChart) { stockInOutChart.destroy(); stockInOutChart = null; }

    stockInOutChart = new Chart(barCtx, {
        type: 'bar',
        data: {
            labels: weekly.labels || [],
            datasets: [
                {
                    label: 'In',
                    data: weekly.stock_in || [],
                    backgroundColor: '#10b981',
                    borderRadius: 4,
                    barPercentage: 0.6
                },
                {
                    label: 'Out',
                    data: weekly.stock_out || [],
                    backgroundColor: '#f43f5e',
                    borderRadius: 4,
                    barPercentage: 0.6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false }, tooltip: { backgroundColor: 'rgba(15, 23, 42, 0.9)', padding: 10, cornerRadius: 8 } },
            scales: { y: { display: false, beginAtZero: true }, x: { grid: { display: false }, ticks: { font: { size: 9 }, color: '#94a3b8' } } }
        }
    });
}

// 5. Interactive Buttons for Chart
function toggleMainChartDataset(datasetIndex) {
    if (!analyticsMainChart) return;
    const isVisible = analyticsMainChart.isDatasetVisible(datasetIndex);
    if (isVisible) {
        analyticsMainChart.hide(datasetIndex);
        const btn = document.getElementById(`legend-btn-${datasetIndex}`);
        if (btn) btn.classList.add('opacity-50', 'grayscale');
    } else {
        analyticsMainChart.show(datasetIndex);
        const btn = document.getElementById(`legend-btn-${datasetIndex}`);
        if (btn) btn.classList.remove('opacity-50', 'grayscale');
    }
}

// ==========================================
// 11. AUTHENTICATION & LOGOUT
// ==========================================

async function doLogout() {
    try {
        // 1. Tell Backend to clear session
        await fetch(`${API_BASE}/api/logout`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error("Logout error", e);
    } finally {
        // 2. Redirect User to the Login Page
        window.location.href = "/login";
    }
}


// ==========================================
// 12. QR SCANNER LOGIC (Updated with Switch)
// ==========================================

let html5QrcodeScanner = null;
let currentQrItem = null;
let currentFacingMode = "environment"; // Default to Back Camera

function startQrScanner() {
    // 1. Initialize Scanner if needed
    if (!html5QrcodeScanner) {
        html5QrcodeScanner = new Html5Qrcode("reader");
    }

    // 2. Start Camera with current mode
    const config = { fps: 10, qrbox: { width: 250, height: 250 } };

    html5QrcodeScanner.start(
        { facingMode: currentFacingMode },
        config,
        onScanSuccess,
        onScanFailure
    ).then(() => {
        // UI Updates: Enable Stop & Switch, Disable Start
        updateScannerUI(true);
        showToast(`Camera started (${currentFacingMode === 'environment' ? 'Back' : 'Front'})`);
    }).catch(err => {
        console.error("Camera error", err);
        alert("Could not access camera. Ensure permissions are granted.");
    });
}

async function stopQrScanner() {
    if (html5QrcodeScanner) {
        try {
            await html5QrcodeScanner.stop();
            updateScannerUI(false);
            html5QrcodeScanner.clear();
        } catch (err) {
            console.error("Stop error", err);
        }
    }
}

async function switchCamera() {
    if (!html5QrcodeScanner) return;

    // 1. Stop current stream
    try {
        await html5QrcodeScanner.stop();
    } catch (e) {
        // Ignore stop errors if it wasn't running perfectly
    }

    // 2. Toggle Mode
    currentFacingMode = (currentFacingMode === "environment") ? "user" : "environment";

    // 3. Restart
    startQrScanner();
}

function updateScannerUI(isScanning) {
    const startBtn = document.getElementById('startScanBtn');
    const stopBtn = document.getElementById('stopScanBtn');
    const switchBtn = document.getElementById('switchCamBtn');

    if (isScanning) {
        startBtn.disabled = true;
        startBtn.classList.add('opacity-50');
        stopBtn.disabled = false;
        stopBtn.classList.remove('opacity-50');
        switchBtn.disabled = false;
        switchBtn.classList.remove('opacity-50');
    } else {
        startBtn.disabled = false;
        startBtn.classList.remove('opacity-50');
        stopBtn.disabled = true;
        stopBtn.classList.add('opacity-50');
        switchBtn.disabled = true;
        switchBtn.classList.add('opacity-50');
    }
}

function onScanSuccess(decodedText, decodedResult) {
    console.log(`Scan result: ${decodedText}`);
    stopQrScanner(); // Automatically stop on success
    lookupQrCode(decodedText);
}

function onScanFailure(error) {
    // console.warn(`Code scan error = ${error}`);
}

// ... (Keep handleManualQrLookup, lookupQrCode, renderQrResult, qrQuickAction exactly as they were) ...
// (These functions below do not need changing, just ensure they are still there)

// Manual Input Handler
function handleManualQrLookup() {
    const input = document.getElementById('qrManualInput');
    const id = input.value.trim();
    if (id) {
        lookupQrCode(id);
        input.value = '';
    }
}

async function lookupQrCode(qrId) {
    const card = document.getElementById('qrResultCard');
    const empty = document.getElementById('qrEmptyState');

    try {
        const res = await fetch(`${API_BASE}/api/batches`);
        const batches = await res.json();

        const match = batches.find(b =>
            (b.qr_code_id && b.qr_code_id.toUpperCase() === qrId.toUpperCase()) ||
            (b.batch_number && b.batch_number.toUpperCase() === qrId.toUpperCase())
        );

        if (match) {
            renderQrResult(match);
        } else {
            showToast("QR Code not found.");
            card.classList.add('hidden');
            empty.classList.remove('hidden');
        }
    } catch (err) {
        console.error("QR Lookup Error", err);
        alert("Error looking up QR code.");
    }
}

function renderQrResult(batch) {
    currentQrItem = batch;
    const card = document.getElementById('qrResultCard');
    const empty = document.getElementById('qrEmptyState');

    document.getElementById('qrResName').textContent = batch.item_name;
    document.getElementById('qrResBatch').textContent = `Batch: ${batch.batch_number}`;
    document.getElementById('qrResStock').textContent = batch.current_stock;
    document.getElementById('qrResBranch').textContent = batch.branch;
    const expDate = batch.exp_date ? new Date(batch.exp_date).toLocaleDateString() : 'N/A';
    document.getElementById('qrResExp').textContent = expDate;

    empty.classList.add('hidden');
    card.classList.remove('hidden');
    card.classList.add('animate-fade-in');
}

async function qrQuickAction(action) {
    if (!currentQrItem) return;

    if (action === 'view') {
        openItemDetails({
            name: currentQrItem.item_name,
            branch: currentQrItem.branch,
            quantity: currentQrItem.current_stock,
            batch_number: currentQrItem.batch_number,
            exp_date: currentQrItem.exp_date,
            // Add other fields if needed
        });
    }
    else if (action === 'consume') {
        if (confirm(`Consume 1 unit of ${currentQrItem.item_name}?`)) {
            try {
                await fetch(`${API_URL}/${encodeURIComponent(currentQrItem.item_name)}/adjust`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ branch: currentQrItem.branch, delta: -1 })
                });

                showToast("Stock consumed!");
                const stockEl = document.getElementById('qrResStock');
                stockEl.textContent = parseInt(stockEl.textContent) - 1;
                fetchInventory();
            } catch (err) {
                alert("Failed to update stock.");
            }
        }
    }
}

// ==========================================
// 13. MOBILE MENU LOGIC
// ==========================================

function toggleMobileMenu() {
    const menu = document.getElementById('mobileMenu');
    if (menu) {
        menu.classList.toggle('hidden');
    }
}

// ==========================================
// SHARED DELETE MODAL LOGIC
// ==========================================

let pendingDelete = {
    type: null, // 'inventory' or 'supplier'
    id: null    // Item Name or Supplier Name
};

// 1. Open the Modal
function openDeleteModal(type, id) {
    pendingDelete = { type, id };

    const modal = document.getElementById('deleteOverlay');
    const msgEl = document.getElementById('deleteMessage');

    // Customize message based on type
    if (type === 'inventory') {
        msgEl.innerHTML = `Are you sure you want to delete item <b>"${id}"</b>?<br>This will also remove all its batches.`;
    } else if (type === 'supplier') {
        msgEl.innerHTML = `Are you sure you want to remove supplier <b>"${id}"</b>?`;
    }

    modal.classList.remove('hidden');
}

// 2. Close the Modal
function closeDeleteModal() {
    document.getElementById('deleteOverlay').classList.add('hidden');
    pendingDelete = { type: null, id: null }; // Reset
}

// 3. Handle Click Outside
function handleDeleteOutsideClick(e) {
    if (e.target.id === 'deleteOverlay') {
        closeDeleteModal();
    }
}

// 4. Execute the actual API Call
async function executeDelete() {
    const { type, id } = pendingDelete;
    if (!type || !id) return;

    try {
        let url = '';
        if (type === 'inventory') {
            url = `${API_URL}/${encodeURIComponent(id)}`;
        } else if (type === 'supplier') {
            url = `${SUPPLIERS_API_URL}/${encodeURIComponent(id)}`;
        }

        const res = await fetch(url, { method: 'DELETE' });

        if (res.ok) {
            showToast(`${type === 'inventory' ? 'Item' : 'Supplier'} deleted successfully`);

            // Refresh the correct section
            if (type === 'inventory') {
                fetchInventory();
                initDashboard();
            } else {
                fetchSuppliers();
            }
        } else {
            alert("Failed to delete. Please try again.");
        }
    } catch (err) {
        console.error(err);
        alert("Network error occurred.");
    } finally {
        closeDeleteModal();
    }
}

// ==========================================
// 14. COMPLIANCE PAGE LOGIC
// ==========================================

function fetchComplianceData() {
    // 1. Fetch Score Overview
    fetch(`${API_BASE}/api/compliance/overview`)
        .then(res => res.json())
        .then(data => {
            document.getElementById('comp-score').textContent = `${data.score}%`;
            document.getElementById('comp-expired').textContent = data.expired_count;
            document.getElementById('comp-low').textContent = data.low_stock_count;

            const statusEl = document.getElementById('comp-status');
            statusEl.textContent = data.status;

            // Color code the status
            if (data.score >= 90) statusEl.className = "text-sm font-medium text-emerald-400 mt-1";
            else if (data.score >= 70) statusEl.className = "text-sm font-medium text-amber-400 mt-1";
            else statusEl.className = "text-sm font-medium text-rose-400 mt-1";
        })
        .catch(err => console.error("Compliance Overview Error:", err));

    // 2. Fetch Audit Logs
    fetch(`${API_BASE}/api/compliance/audit-logs`)
        .then(res => res.json())
        .then(logs => {
            const tbody = document.getElementById('auditLogTable');
            if (!tbody) return;
            tbody.innerHTML = '';

            if (logs.length === 0) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center py-8 text-slate-400">No recent activity recorded.</td></tr>`;
                return;
            }

            logs.forEach(log => {
                // Determine Badge Color based on Direction (In vs Out)
                const isOut = log.direction === 'out';
                const badgeClass = isOut
                    ? "bg-rose-50 text-rose-600 border-rose-100"
                    : "bg-emerald-50 text-emerald-600 border-emerald-100";

                const actionLabel = isOut ? "Stock Used / Adjusted" : "Stock Added / Restocked";
                const dateStr = new Date(log.date).toLocaleString();

                tbody.innerHTML += `
                <tr class="hover:bg-slate-50/50 transition">
                    <td class="px-6 py-4 font-mono text-xs text-slate-500">${dateStr}</td>
                    <td class="px-6 py-4">
                        <span class="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-bold border ${badgeClass}">
                            ${log.direction.toUpperCase()}
                        </span>
                    </td>
                    <td class="px-6 py-4 font-medium text-slate-700">${log.name}</td>
                    <td class="px-6 py-4 text-xs text-slate-500">${log.branch || 'Main'}</td>
                    <td class="px-6 py-4 text-right font-bold ${isOut ? 'text-rose-600' : 'text-emerald-600'}">
                        ${isOut ? '-' : '+'}${log.quantity_used}
                    </td>
                </tr>`;
            });
        })
        .catch(err => console.error("Audit Log Error:", err));
}

// ==========================================
// 14. COMPLIANCE & AUDIT LOGIC (Enhanced)
// ==========================================

let allAuditLogs = []; // Store logs locally for filtering

function fetchComplianceData() {
    // 1. Fetch Score Overview
    fetch(`${API_BASE}/api/compliance/overview`)
        .then(res => res.json())
        .then(data => {
            document.getElementById('comp-score').textContent = `${data.score}%`;
            document.getElementById('comp-expired').textContent = data.expired_count;
            document.getElementById('comp-low').textContent = data.low_stock_count;

            const statusEl = document.getElementById('comp-status');
            statusEl.textContent = data.status;

            if (data.score >= 90) statusEl.className = "text-sm font-medium text-emerald-400 mt-1";
            else if (data.score >= 70) statusEl.className = "text-sm font-medium text-amber-400 mt-1";
            else statusEl.className = "text-sm font-medium text-rose-400 mt-1";
        })
        .catch(err => console.error("Compliance Error:", err));

    // 2. Fetch Audit Logs
    fetch(`${API_BASE}/api/compliance/audit-logs`)
        .then(res => res.json())
        .then(logs => {
            allAuditLogs = logs; // Save for filtering
            renderAuditTable(logs);
        })
        .catch(err => console.error("Audit Log Error:", err));
}

function renderAuditTable(logs) {
    const tbody = document.getElementById('auditLogTable');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center py-10 text-slate-400">No logs matching criteria.</td></tr>`;
        return;
    }

    logs.forEach(log => {
        const isOut = log.direction === 'out';
        const badgeClass = isOut
            ? "bg-rose-50 text-rose-600 border border-rose-100"
            : "bg-emerald-50 text-emerald-600 border border-emerald-100";

        const dateStr = new Date(log.date).toLocaleDateString() + ' ' + new Date(log.date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // NEW: Use the reason category or fallback
        const reason = log.reason_category || (isOut ? "Usage" : "Restock");

        tbody.innerHTML += `
        <tr class="hover:bg-slate-50/80 transition">
            <td class="px-6 py-3 font-mono text-xs text-slate-500">${dateStr}</td>
            <td class="px-6 py-3">
                <div class="flex flex-col">
                    <span class="inline-flex w-fit items-center px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wide ${badgeClass}">
                        ${log.direction.toUpperCase()}
                    </span>
                    <span class="text-[10px] text-slate-400 mt-1 font-medium">${reason}</span>
                </div>
            </td>
            <td class="px-6 py-3 font-bold text-slate-700">${log.name}</td>
            <td class="px-6 py-3 text-xs text-slate-500">${log.branch || 'Main'}</td>
            <td class="px-6 py-3 text-right font-mono font-bold ${isOut ? 'text-rose-600' : 'text-emerald-600'}">
                ${isOut ? '-' : '+'}${log.quantity_used}
            </td>
        </tr>`;
    });
}

// Filter Function (Client-Side)
function filterAuditLogs() {
    const searchTerm = document.getElementById('auditSearch').value.toLowerCase();
    const dateVal = document.getElementById('auditDate').value; // YYYY-MM-DD

    const filtered = allAuditLogs.filter(log => {
        const matchesName = log.name.toLowerCase().includes(searchTerm) ||
            (log.branch && log.branch.toLowerCase().includes(searchTerm));

        let matchesDate = true;
        if (dateVal) {
            // Compare only the YYYY-MM-DD part
            const logDate = new Date(log.date).toISOString().split('T')[0];
            matchesDate = (logDate === dateVal);
        }

        return matchesName && matchesDate;
    });

    renderAuditTable(filtered);
}

// PDF Download Function
function downloadComplianceReport() {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    // 1. Header & Branding
    doc.setFontSize(18);
    doc.setTextColor(30, 41, 59); // Slate-800
    doc.text("PREMIERLUX INVENTORY", 14, 20);

    doc.setFontSize(10);
    doc.setTextColor(100, 116, 139); // Slate-500
    doc.text("Compliance & Audit Report", 14, 26);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 31);

    // 2. Score Summary Box
    const score = document.getElementById('comp-score').textContent;
    const expired = document.getElementById('comp-expired').textContent;

    doc.setDrawColor(226, 232, 240); // Border color
    doc.setFillColor(248, 250, 252); // Light bg
    doc.roundedRect(14, 40, 180, 25, 3, 3, 'FD');

    doc.setFontSize(12);
    doc.setTextColor(30, 41, 59);
    doc.text(`Compliance Score: ${score}`, 20, 56);
    doc.text(`Expired Items: ${expired}`, 100, 56);

    // 3. Table Data Preparation
    // We filter the data based on what the user currently sees
    const searchTerm = document.getElementById('auditSearch').value.toLowerCase();
    const dateVal = document.getElementById('auditDate').value;

    // Re-run filter logic to get current dataset
    const dataToPrint = allAuditLogs.filter(log => {
        const matchesName = log.name.toLowerCase().includes(searchTerm);
        let matchesDate = true;
        if (dateVal) matchesDate = (new Date(log.date).toISOString().split('T')[0] === dateVal);
        return matchesName && matchesDate;
    });

    const tableRows = dataToPrint.map(log => [
        new Date(log.date).toLocaleDateString(),
        log.direction.toUpperCase(),
        log.name,
        log.branch || 'Main',
        (log.direction === 'out' ? '-' : '+') + log.quantity_used
    ]);

    // 4. Generate Table
    doc.autoTable({
        startY: 75,
        head: [['Date', 'Action', 'Item Name', 'Branch', 'Qty']],
        body: tableRows,
        theme: 'grid',
        headStyles: { fillColor: [15, 23, 42], textColor: 255 }, // Slate-900 header
        styles: { fontSize: 9, cellPadding: 3 },
        alternateRowStyles: { fillColor: [248, 250, 252] }
    });

    // 5. Save
    doc.save(`Premierlux_Audit_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
}

// ==========================================
// 15. USER ACCOUNTS MANAGEMENT (Enhanced)
// ==========================================

function fetchUsers() {
    fetch(`${API_BASE}/api/users`)
        .then(res => res.json())
        .then(users => {
            const tbody = document.getElementById('usersTableBody');
            if (!tbody) return;
            tbody.innerHTML = '';

            if (users.error) {
                tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-rose-500">Access Denied: Owner/Admin Only</td></tr>`;
                return;
            }

            users.forEach(u => {
                // 1. Role Badges
                let roleColor = 'bg-slate-100 text-slate-500 border border-slate-200'; // Staff default
                if (u.role === 'admin') roleColor = 'bg-emerald-50 text-emerald-600 border border-emerald-100';
                if (u.role === 'owner') roleColor = 'bg-purple-50 text-purple-600 border border-purple-100 ring-2 ring-purple-500/10';

                // 2. Branch Badges
                let branchBadge = `<span class="text-xs font-semibold text-slate-600">${u.branch || 'Main'}</span>`;
                if (u.branch === 'All') branchBadge = `<span class="text-[10px] font-black bg-slate-800 text-white px-2 py-0.5 rounded-full tracking-wider">HEADQUARTERS</span>`;

                // 3. Delete Button Logic (Never show delete for Owner)
                const deleteBtn = u.role === 'owner' ? '' : `
                    <button onclick="deleteUser('${u._id}')" class="group p-2 rounded-lg hover:bg-rose-50 transition-colors" title="Delete User">
                        <svg class="w-4 h-4 text-slate-300 group-hover:text-rose-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                        </svg>
                    </button>`;

                tbody.innerHTML += `
                <tr class="hover:bg-slate-50/80 transition border-b border-slate-50 last:border-0">
                    <td class="px-6 py-4">
                        <div class="font-bold text-slate-700">${u.name}</div>
                    </td>
                    <td class="px-6 py-4 text-xs text-slate-500 font-mono">${u.email}</td>
                    <td class="px-6 py-4">
                        <span class="inline-flex items-center px-3 py-1 rounded-lg text-[10px] font-bold uppercase tracking-widest ${roleColor}">
                            ${u.role}
                        </span>
                    </td>
                    <td class="px-6 py-4">${branchBadge}</td>
                    <td class="px-6 py-4 text-right">
                        ${deleteBtn}
                    </td>
                </tr>`;
            });
        })
        .catch(err => console.error(err));
}

function openUserModal() {
    document.getElementById('userOverlay').classList.remove('hidden');

    // Populate Branch Dropdown (Real branches only, no "All/Owner")
    const branchSelect = document.getElementById('new_user_branch');
    if (branchSelect) {
        // Reset with a placeholder
        branchSelect.innerHTML = '<option value="" disabled selected>Select a Branch...</option>';

        fetch(BRANCHES_API_URL)
            .then(res => res.json())
            .then(branches => {
                if (branches.length === 0) {
                    branchSelect.innerHTML = '<option disabled>No branches found</option>';
                } else {
                    branches.forEach(b => {
                        branchSelect.innerHTML += `<option value="${b.name}">${b.name}</option>`;
                    });
                }
            });
    }
}

function submitUserForm(e) {
    e.preventDefault();

    const roleVal = document.getElementById('new_user_role').value;
    const branchVal = document.getElementById('new_user_branch').value;

    // Validation
    if (!roleVal) { alert("Please select a Role."); return; }
    if (!branchVal) { alert("Please select a Branch."); return; }

    const payload = {
        name: document.getElementById('new_user_name').value,
        email: document.getElementById('new_user_email').value,
        password: document.getElementById('new_user_pass').value,
        role: roleVal,
        branch: branchVal
    };

    fetch(`${API_BASE}/api/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }).then(res => {
        if (res.ok) {
            showToast("User created successfully");
            closeUserModal();
            fetchUsers();
        } else {
            res.json().then(data => alert(data.error || "Failed to create user"));
        }
    });
}

function deleteUser(id) {
    if (!confirm("Delete this user?")) return;
    fetch(`${API_BASE}/api/users/${id}`, { method: 'DELETE' })
        .then(res => {
            if (res.ok) {
                showToast("User deleted");
                fetchUsers();
            } else {
                alert("Action failed (Unauthorized)");
            }
        });
}

function closeUserModal() { document.getElementById('userOverlay').classList.add('hidden'); }
function handleUserOutsideClick(e) { if (e.target.id === 'userOverlay') closeUserModal(); }

// --- CUSTOM USER DROPDOWN LOGIC ---

// 1. Role Dropdown
function toggleUserRoleMenu() {
    const menu = document.getElementById('roleDropdownOptions');
    // Close other menu if open
    document.getElementById('userBranchOptions').classList.add('hidden');
    if (menu) menu.classList.toggle('hidden');
}

function selectUserRole(value, label) {
    document.getElementById('new_user_role').value = value;
    const btnLabel = document.getElementById('roleLabel');
    btnLabel.textContent = label;
    btnLabel.classList.add('text-slate-800'); // Make text darker to show selection
    document.getElementById('roleDropdownOptions').classList.add('hidden');
}

// 2. Branch Dropdown
function toggleUserBranchMenu() {
    const menu = document.getElementById('userBranchOptions');
    // Close other menu if open
    document.getElementById('roleDropdownOptions').classList.add('hidden');
    if (menu) menu.classList.toggle('hidden');
}

function selectUserBranch(name) {
    document.getElementById('new_user_branch').value = name;
    const btnLabel = document.getElementById('userBranchLabel');
    btnLabel.textContent = name;
    btnLabel.classList.add('text-slate-800');
    document.getElementById('userBranchOptions').classList.add('hidden');
}

// 3. Updated Open Modal (Populates the Custom Branch List)
function openUserModal() {
    document.getElementById('userOverlay').classList.remove('hidden');

    // Reset Fields
    document.getElementById('new_user_role').value = '';
    document.getElementById('roleLabel').textContent = 'Select Role...';
    document.getElementById('new_user_branch').value = '';
    document.getElementById('userBranchLabel').textContent = 'Select Branch...';

    // Populate Custom Branch Options
    const container = document.getElementById('userBranchOptions');
    if (container) {
        container.innerHTML = '<div class="p-2 text-xs text-slate-400 text-center">Loading...</div>';

        fetch(BRANCHES_API_URL)
            .then(res => res.json())
            .then(branches => {
                container.innerHTML = '';
                if (branches.length === 0) {
                    container.innerHTML = '<div class="p-2 text-xs text-slate-400 text-center">No branches found</div>';
                } else {
                    branches.forEach(b => {
                        container.innerHTML += `
                            <button type="button" onclick="selectUserBranch('${b.name}')" 
                                class="w-full text-left px-3 py-2 rounded-lg text-sm font-medium text-slate-600 hover:bg-emerald-50 hover:text-emerald-600 transition">
                                ${b.name}
                            </button>`;
                    });
                }
            });
    }
}

// ==========================================
// 0. AUTH & ROLE MANAGEMENT
// ==========================================

let currentUser = null;

async function checkCurrentUser() {
    try {
        const res = await fetch(`${API_BASE}/api/me`);
        if (!res.ok) {
            // If session expired or invalid, logout
            doLogout();
            return;
        }
        currentUser = await res.json();

        // 1. Update UI with User Info
        updateUserInterface();

        // 2. Apply Role Restrictions
        applyRolePermissions();

    } catch (err) {
        console.error("Auth check failed", err);
    }
}

function updateUserInterface() {
    // Example: You could add a welcome message in the navbar if you have an element for it
    // document.getElementById('userNameDisplay').textContent = currentUser.name;
    console.log(`Logged in as: ${currentUser.name} (${currentUser.role})`);
}

function applyRolePermissions() {
    if (!currentUser) return;

    const adminMenu = document.getElementById('adminMenuBtn');
    const ownerSettingsBtn = document.getElementById('ownerSettingsBtn'); // <--- NEW

    // 1. Staff: Hide entire Admin Menu
    if (currentUser.role === 'staff') {
        if (adminMenu) adminMenu.classList.add('hidden');
    } else {
        if (adminMenu) adminMenu.classList.remove('hidden');
    }

    // 2. Owner: Show Settings Button (Hide for Admin)
    if (ownerSettingsBtn) {
        if (currentUser.role === 'owner') {
            ownerSettingsBtn.classList.remove('hidden');
        } else {
            ownerSettingsBtn.classList.add('hidden');
        }
    }
}

// ==========================================
// 16. ADMIN ROLES PAGE LOGIC
// ==========================================

function fetchRoleStats() {
    // We reuse the existing /api/users endpoint to calculate stats client-side
    fetch(`${API_BASE}/api/users`)
        .then(res => res.json())
        .then(users => {
            if (users.error) return; // If permission denied, numbers stay 0

            // Initialize counts
            let counts = { owner: 0, admin: 0, staff: 0 };

            // Count roles
            users.forEach(u => {
                const r = (u.role || 'staff').toLowerCase();
                if (counts[r] !== undefined) {
                    counts[r]++;
                }
            });

            // Animate Numbers (Simple increment effect)
            animateValue("count-owner", 0, counts.owner, 1000);
            animateValue("count-admin", 0, counts.admin, 1000);
            animateValue("count-staff", 0, counts.staff, 1000);
        })
        .catch(err => console.error("Role stats error:", err));
}

// Helper: Number Animation
function animateValue(id, start, end, duration) {
    const obj = document.getElementById(id);
    if (!obj) return;
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        obj.innerHTML = Math.floor(progress * (end - start) + start);
        if (progress < 1) {
            window.requestAnimationFrame(step);
        }
    };
    window.requestAnimationFrame(step);
}

// ==========================================
// 17. OWNER SETTINGS (Governance)
// ==========================================

function initOwnerSettings() {
    // Fetch current status
    fetch(`${API_BASE}/api/admin/settings`)
        .then(res => res.json())
        .then(data => {
            const toggle = document.getElementById('lockdownToggle');
            const status = document.getElementById('lockdownStatus');

            if (toggle) {
                toggle.checked = data.lockdown;
                status.textContent = data.lockdown ? "Active" : "Off";
                status.className = data.lockdown
                    ? "ml-3 text-sm font-bold text-rose-600 animate-pulse"
                    : "ml-3 text-sm font-medium text-slate-700";
            }
        })
        .catch(err => console.error(err));
}

function toggleSystemLockdown() {
    const toggle = document.getElementById('lockdownToggle');
    const isLocked = toggle.checked;

    fetch(`${API_BASE}/api/admin/lockdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: isLocked })
    })
        .then(res => res.json())
        .then(data => {
            showToast(data.message);
            initOwnerSettings(); // Refresh UI
        });
}

function wipeAuditLogs() {
    if (confirm("⚠️ CRITICAL WARNING ⚠️\n\nAre you sure you want to delete ALL system logs?\nThis action cannot be undone.")) {
        fetch(`${API_BASE}/api/admin/clear-logs`, { method: 'DELETE' })
            .then(res => res.json())
            .then(data => {
                if (data.error) alert(data.error);
                else showToast("Audit logs cleared");
            });
    }
}


// ==========================================
// 18. QR GENERATOR & PRINTING
// ==========================================

// A. Generate Custom QR in the QR Section
function generateCustomQR() {
    const text = document.getElementById('qrGenInput').value.trim();
    const container = document.getElementById('qrGenCanvas');
    const printBtn = document.getElementById('printQrBtn');

    if (!text) return alert("Please enter text or Batch ID");

    container.innerHTML = ""; // Clear previous

    // Generate new QR
    new QRCode(container, {
        text: text,
        width: 128,
        height: 128,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: QRCode.CorrectLevel.H
    });

    // Show Print Button
    printBtn.classList.remove('hidden');
}

// B. Print the Custom QR
function printCustomQR() {
    const container = document.getElementById('qrGenCanvas');
    const img = container.querySelector('img');
    if (!img) return;

    const win = window.open('', '', 'height=500,width=500');
    win.document.write('<html><head><title>Print QR</title></head><body style="text-align:center; padding-top: 50px;">');
    win.document.write(`<img src="${img.src}" style="width:200px; height:200px; border: 1px solid #ccc; padding: 10px;">`);
    win.document.write(`<p style="font-family: monospace; margin-top: 10px; font-size: 20px;">${document.getElementById('qrGenInput').value}</p>`);
    win.document.write('</body></html>');
    win.document.close();
    win.print();
}

// C. Auto-Generate QR inside Item Details Modal
function generateDetailQR(qrText) {
    const container = document.getElementById('detail_qr_image');
    if (!container) return;
    container.innerHTML = ""; // Clear

    if (qrText && qrText !== '-' && qrText !== 'N/A') {
        new QRCode(container, {
            text: qrText,
            width: 64, // Smaller for modal
            height: 64
        });
    } else {
        container.innerHTML = "<span class='text-[8px] text-slate-300 flex items-center justify-center h-full'>No ID</span>";
    }
}

// D. Print from Item Details
function printDetailQR() {
    const text = document.getElementById('detail_qr').textContent;
    const container = document.getElementById('detail_qr_image');
    const img = container.querySelector('img');

    if (!img) return alert("No QR code to print.");

    const win = window.open('', '', 'height=500,width=500');
    win.document.write('<html><head><title>Print Label</title></head><body style="text-align:center; padding-top: 50px;">');
    win.document.write(`<img src="${img.src}" style="width:200px; height:200px;">`);
    win.document.write(`<p style="font-family: monospace; font-weight:bold;">${document.getElementById('detail_name').textContent}</p>`);
    win.document.write(`<p style="font-family: monospace;">${text}</p>`);
    win.document.write('</body></html>');
    win.document.close();
    win.print();
}


// ==========================================
// 19. OWNER GOVERNANCE (Broadcast, Backup, Kill Switch)
// ==========================================

function sendSystemBroadcast() {
    const input = document.getElementById('broadcastMsg');
    const msg = input.value.trim();
    if (!msg) return;

    fetch(`${API_BASE}/api/admin/broadcast`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg })
    })
        .then(res => res.json())
        .then(data => {
            showToast("📢 Broadcast Sent!");
            input.value = "";
        });
}

function forceLogoutAll() {
    if (!confirm("⚡ EMERGENCY: Are you sure you want to force logout ALL users?\nThey will be disconnected immediately.")) return;

    fetch(`${API_BASE}/api/admin/kill-sessions`, { method: 'POST' })
        .then(res => res.json())
        .then(data => showToast("⚡ Kill command executed."));
}

function downloadSystemBackup() {
    window.open(`${API_BASE}/api/admin/backup`, '_blank');
}

// --- SOCKET LISTENERS FOR GOVERNANCE ---
// Add this inside your existing socket initialization or at the bottom of the file

const governanceSocket = io(API_BASE); // Connect to default namespace

// 1. Listen for Broadcasts
governanceSocket.on('system_broadcast', (data) => {
    // Show a special sticky toast or alert
    const msg = data.message;
    // Simple custom alert style
    const div = document.createElement('div');
    div.className = "fixed top-10 left-1/2 -translate-x-1/2 bg-indigo-900 text-white px-6 py-4 rounded-xl shadow-2xl z-[300] flex items-center gap-4 animate-bounce-slight";
    div.innerHTML = `
        <span class="text-2xl">📢</span>
        <div>
            <p class="text-xs font-bold uppercase text-indigo-300">System Announcement</p>
            <p class="font-bold text-sm">${msg}</p>
        </div>
        <button onclick="this.parentElement.remove()" class="bg-white/20 hover:bg-white/30 rounded-full w-6 h-6 flex items-center justify-center text-[10px]">✕</button>
    `;
    document.body.appendChild(div);

    // Auto remove after 10s
    setTimeout(() => div.remove(), 10000);
});

// 2. Listen for Kill Switch
governanceSocket.on('force_logout_event', (data) => {
    // If I am NOT the owner, I must logout
    // (We check the role stored in JS variable or localStorage)
    const myRole = localStorage.getItem('user_role'); // Ensure you save this on login

    if (myRole !== 'owner') {
        alert("⚡ SESSION TERMINATED\nThe system administrator has forced a global logout.");
        doLogout();
    }
});

// ==========================================
//  🧠 GEMINI AI FRONTEND LOGIC
// ==========================================

async function initAIModule() {
    const aiTextEl = document.getElementById('dash-ai-text');
    const aiStatsEl = document.getElementById('dash-ai-stats');

    if (!aiTextEl) return;

    // 1. Loading UI
    aiTextEl.innerHTML = `
        <div class="flex flex-col gap-2 animate-pulse">
            <div class="flex items-center gap-2 text-indigo-300">
                <i class="fas fa-brain fa-spin"></i> 
                <span>Consulting AI...</span>
            </div>
            <span class="text-xs text-slate-400">Analyzing inventory risks...</span>
        </div>`;

    aiStatsEl.innerHTML = `<span>⏳</span> Connecting...`;
    aiStatsEl.className = "px-3 py-1.5 bg-white/5 border border-white/10 rounded-lg text-xs font-bold text-slate-300 flex items-center gap-2";

    try {
        const res = await fetch(`${API_BASE}/api/ai/analyze`);
        const data = await res.json();

        // ➤ SAFETY CHECK: Ensure data exists
        const summary = data.insight_text || data.error || "No insights available.";
        const badge = data.status_badge || "Unknown";

        // 2. Render Text
        aiTextEl.style.opacity = 0;
        setTimeout(() => {
            aiTextEl.innerHTML = summary;
            aiTextEl.style.opacity = 1;
            aiTextEl.classList.add('transition-opacity', 'duration-500');
        }, 300);

        // 3. Update Badge Color
        let badgeClass = "bg-indigo-500/20 text-indigo-200 border-indigo-500/30";
        let icon = "🤖";

        if (badge.includes('Critical') || badge.includes('Error')) {
            badgeClass = "bg-rose-500/20 text-rose-300 border-rose-500/30";
            icon = "🚨";
        } else if (badge.includes('Healthy')) {
            badgeClass = "bg-emerald-500/20 text-emerald-300 border-emerald-500/30";
            icon = "✅";
        }

        aiStatsEl.className = `px-3 py-1.5 rounded-lg text-xs font-bold border shadow-sm flex items-center gap-2 ${badgeClass}`;
        aiStatsEl.innerHTML = `<span>${icon}</span> ${badge}`;

        // 4. Render Suggestions button if available
        if (data.recommended_order && data.recommended_order.length > 0) {
            renderAiSuggestions(data.recommended_order);
        }

    } catch (error) {
        console.error("AI Error:", error);
        aiTextEl.innerHTML = "Connection to AI failed.";
        aiStatsEl.innerHTML = "Offline";
    }
}

function renderAiSuggestions(suggestions) {
    const container = document.getElementById('dash-ai-text').parentNode;

    // Remove old button if exists
    const oldBtn = document.getElementById('ai-restock-btn');
    if (oldBtn) oldBtn.remove();

    const btn = document.createElement('button');
    btn.id = "ai-restock-btn";
    btn.className = "mt-4 w-full py-3 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 rounded-xl text-xs font-bold text-white shadow-lg shadow-indigo-500/30 transition flex items-center justify-center gap-2 transform active:scale-95";
    btn.innerHTML = `<span>⚡</span> Review ${suggestions.length} Recommendations`;

    // ➤ CHANGED: Now opens the beautiful overlay
    btn.onclick = () => openAiOverlay(suggestions);

    container.appendChild(btn);
}

// ==========================================
// 🤖 LUX AI OVERLAY LOGIC
// ==========================================

function openAiOverlay(suggestions) {
    const overlay = document.getElementById('aiOverlay');
    const list = document.getElementById('aiRecommendationsList');

    if (!overlay || !list) return;

    list.innerHTML = '';

    if (!suggestions || suggestions.length === 0) {
        list.innerHTML = `
            <div class="flex flex-col items-center justify-center py-10 text-[#8D6E9E] opacity-70">
                <i class="fas fa-check-circle text-4xl mb-3"></i>
                <span class="text-sm font-bold">LUX detects no urgent issues.</span>
            </div>`;
    } else {
        suggestions.forEach(item => {
            // Sanitize inputs
            const safeName = (item.item || 'Unknown').replace(/'/g, "\\'");
            const reason = item.reason || 'Recommended by LUX';
            const qty = item.qty || 10;
            const branch = item.branch || 'Main';

            // ➤ THEMED CARD DESIGN
            list.innerHTML += `
            <div class="flex items-center justify-between p-4 mb-3 rounded-2xl bg-white border border-[#5E4074]/10 shadow-sm hover:shadow-md transition-all group relative overflow-hidden">
                <div class="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-[#382546] to-[#5E4074]"></div>
                
                <div class="flex items-center gap-4 pl-3">
                    <div class="bg-[#5E4074]/10 text-[#5E4074] w-12 h-12 rounded-xl flex items-center justify-center font-bold text-xl shrink-0 shadow-sm border border-[#5E4074]/5">
                        📦
                    </div>
                    <div>
                        <h4 class="font-extrabold text-[#382546] text-sm leading-tight">${item.item}</h4>
                        <p class="text-[10px] text-white font-bold uppercase tracking-wide mt-1.5 bg-[#8D6E9E] w-fit px-2 py-0.5 rounded-md shadow-sm">
                            ${reason}
                        </p>
                    </div>
                </div>

                <div class="flex flex-col items-end gap-2">
                    <span class="text-xs font-bold text-[#8D6E9E]">Qty: <span class="text-[#382546] text-lg font-extrabold">${qty}</span></span>
                    
                    <button onclick="openRestockModal('${safeName}', '${branch}', 0); setTimeout(() => { document.getElementById('restock_qty').value = ${qty}; }, 100); closeAiOverlay();" 
                        class="px-4 py-2 rounded-xl bg-[#5E4074] hover:bg-[#382546] text-white text-xs font-bold transition shadow-md hover:shadow-lg active:scale-95 flex items-center gap-2">
                        <span>Order Now</span>
                        <i class="fas fa-arrow-right"></i>
                    </button>
                </div>
            </div>
            `;
        });
    }

    overlay.classList.remove('hidden');
}

function closeAiOverlay() {
    const overlay = document.getElementById('aiOverlay');
    if (overlay) overlay.classList.add('hidden');
}


// The "Brain" - Analyzes data to find the most important story
function runHeuristicAnalysis(items) {
    if (!items || items.length === 0) {
        return { message: "Inventory is empty. Add stock to generate predictive insights.", stat: "0 Items" };
    }

    let criticalItem = null;
    let lowestDaysLeft = 999;
    let totalValue = 0;
    let deadStockCount = 0;

    items.forEach(item => {
        // Calculate Total Value
        const price = parseFloat(item.price) || 0;
        const qty = parseInt(item.quantity) || 0;
        const usage = parseInt(item.monthly_usage) || 1; // Avoid divide by zero
        totalValue += price * qty;

        // Predict Stockout (Days remaining)
        // Formula: (Current Stock / Monthly Usage) * 30 days
        if (usage > 0 && qty > 0) {
            const daysLeft = (qty / usage) * 30;
            if (daysLeft < lowestDaysLeft) {
                lowestDaysLeft = daysLeft;
                criticalItem = item;
            }
        }

        // Detect Dead Stock (Stock > 6 months of usage)
        if (qty > (usage * 6)) {
            deadStockCount++;
        }
    });

    // ➤ DECISION TREE: Pick the most urgent insight

    // Scenario A: Urgent Stockout Risk
    if (criticalItem && lowestDaysLeft <= 7) {
        const days = Math.round(lowestDaysLeft);
        return {
            message: `⚠️ <b>Critical Alert:</b> Based on current consumption velocity, <span class="text-rose-300 font-bold">${criticalItem.name}</span> will be fully depleted in approximately <b>${days} days</b>. Immediate procurement is recommended to avoid operational disruption.`,
            stat: `📉 High Velocity: ${criticalItem.name}`
        };
    }

    // Scenario B: Dead Stock Warning
    if (deadStockCount > 3) {
        return {
            message: `📊 <b>Efficiency Insight:</b> I've detected <b>${deadStockCount} items</b> that are overstocked (exceeding 6 months of supply). This ties up roughly <b>₱${(totalValue * 0.15).toLocaleString()}</b> in stagnant capital. Consider running a promotion or reducing order frequency.`,
            stat: `🐢 ${deadStockCount} Slow Movers`
        };
    }

    // Scenario C: Healthy State (General Value Analysis)
    return {
        message: `✅ <b>System Optimal:</b> Inventory health is stable. Your total holding value is <b>₱${totalValue.toLocaleString()}</b>. No critical stockouts predicted for the next 14 days. Great job maintaining balance!`,
        stat: `💰 Value: ₱${(totalValue / 1000).toFixed(1)}k`
    };
}

// Visual Effect: Types text character by character
function typeWriterEffect(element, html) {
    element.innerHTML = ""; // Clear
    element.classList.remove('animate-pulse');

    // We use a temporary div to parse HTML tags so we don't break bold tags while typing
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    // For simplicity in this specific "AI" context, we'll just fade it in smoothly 
    // because parsing HTML tags for a typewriter effect is complex and prone to bugs.
    element.innerHTML = html;
    element.classList.add('animate-fade-in');
}
// ==========================================
// ✨ LUX CHATBOT LOGIC
// ==========================================

// ➤ FIX: This variable MUST be defined here
let currentLuxImageBase64 = null;

function toggleLuxChat() {
    const windowEl = document.getElementById('luxChatWindow');
    const btn = document.getElementById('luxChatBtn');

    if (windowEl.classList.contains('hidden')) {
        // Open
        windowEl.classList.remove('hidden');
        setTimeout(() => {
            windowEl.classList.remove('scale-95', 'opacity-0');
            windowEl.classList.add('scale-100', 'opacity-100');
        }, 10);
        btn.classList.add('rotate-90', 'opacity-0');
        setTimeout(() => btn.classList.add('hidden'), 200);
    } else {
        // Close
        windowEl.classList.remove('scale-100', 'opacity-100');
        windowEl.classList.add('scale-95', 'opacity-0');
        setTimeout(() => windowEl.classList.add('hidden'), 300);

        btn.classList.remove('hidden');
        setTimeout(() => btn.classList.remove('rotate-90', 'opacity-0'), 10);
    }
}

function handleLuxImageSelect() {
    const input = document.getElementById('luxImageInput');
    const file = input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = function () {
        currentLuxImageBase64 = reader.result;
        // Show Preview
        const preview = document.getElementById('luxImagePreview');
        const img = document.getElementById('luxPreviewImg');
        img.src = currentLuxImageBase64;
        preview.classList.remove('hidden');
    }
    reader.readAsDataURL(file);
}

function clearLuxImage() {
    currentLuxImageBase64 = null;
    document.getElementById('luxImageInput').value = "";
    document.getElementById('luxImagePreview').classList.add('hidden');
}

async function sendLuxMessage(e) {
    e.preventDefault(); // Prevents page reload on Enter
    const input = document.getElementById('luxChatInput');
    const msg = input.value.trim();

    // Allow sending if there is text OR an image
    if (!msg && !currentLuxImageBase64) return;

    // 1. Add User Message to Chat
    let displayMsg = msg;
    if (currentLuxImageBase64) {
        displayMsg += `<br><img src="${currentLuxImageBase64}" class="mt-2 rounded-lg w-32 h-32 object-cover border border-white/20">`;
    }
    addChatBubble(displayMsg, 'user');

    // Clear Input UI immediately
    input.value = '';
    const imageToSend = currentLuxImageBase64;
    clearLuxImage();

    // 2. Add "Thinking" Bubble
    const thinkingId = addChatBubble('<i class="fas fa-circle-notch fa-spin"></i> Analyzing...', 'lux', true);

    try {
        const res = await fetch(`${API_BASE}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: msg,
                image: imageToSend
            })
        });

        const data = await res.json();

        // Remove thinking bubble
        const thinkingEl = document.getElementById(thinkingId);
        if (thinkingEl) thinkingEl.remove();

        // 3. Add LUX Response
        if (data.type === 'error') {
            addChatBubble("⚠️ " + data.text, 'lux');
        } else {
            let formattedText = data.text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
            formattedText = formattedText.replace(/\n/g, '<br>');
            addChatBubble(formattedText, 'lux');
        }

    } catch (err) {
        console.error(err);
        document.getElementById(thinkingId)?.remove();
        addChatBubble("Sorry, I lost connection to the server.", 'lux');
    }
}

function addChatBubble(text, sender, isThinking = false) {
    const container = document.getElementById('luxChatMessages');
    const id = 'msg-' + Date.now();
    const isUser = sender === 'user';

    const userStyle = "bg-[#5E4074] text-white rounded-br-none shadow-md";
    const luxStyle = "bg-white border border-slate-100 text-slate-600 rounded-tl-none shadow-sm";
    const align = isUser ? "self-end flex-row-reverse" : "self-start";

    // ➤ CHANGED: LUX Icon is now a Tooth
    const avatar = isUser
        ? `<div class="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-xs shrink-0 text-slate-500"><i class="fas fa-user"></i></div>`
        : `<div class="w-8 h-8 rounded-full bg-gradient-to-br from-[#382546] to-[#5E4074] flex items-center justify-center text-xs text-white shrink-0 shadow-sm"><i class="fas fa-tooth"></i></div>`;

    const html = `
    <div id="${id}" class="flex gap-3 max-w-[85%] ${align} ${isThinking ? 'animate-pulse' : 'animate-fade-in-up'}">
        ${avatar}
        <div class="p-3 rounded-2xl text-sm leading-relaxed ${isUser ? userStyle : luxStyle}">
            ${text}
        </div>
    </div>`;

    container.insertAdjacentHTML('beforeend', html);
    container.scrollTop = container.scrollHeight;

    return id;
}

async function fetchPriceInsights() {
    const list = document.getElementById('lux-price-prediction-list');
    const summaryEl = document.getElementById('lux-market-summary');
    const statusEl = document.getElementById('lux-market-status');

    try {
        const res = await fetch(`${API_BASE}/api/ai/market-intelligence`);
        const data = await res.json();

        if (data.error) throw new Error(data.error);

        // 1. Update Dashboard Summary Widget
        if (summaryEl) summaryEl.innerHTML = `"${data.market_summary}"`;
        if (statusEl) statusEl.innerHTML = "Live Feed";

        // 2. Update Analytics List (if on the analytics page)
        if (list) {
            list.innerHTML = "";
            data.predictions.forEach(pred => {
                const trendColor = pred.trend === 'Rising' ? 'text-rose-500' : 'text-emerald-500';
                const trendIcon = pred.trend === 'Rising' ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';

                list.innerHTML += `
                <div class="p-4 rounded-2xl bg-white border border-slate-100 hover:border-emerald-500/30 transition group shadow-sm">
                    <div class="flex justify-between items-start mb-1">
                        <span class="font-bold text-slate-800 text-sm">${pred.item}</span>
                        <span class="text-[9px] font-black uppercase ${trendColor} flex items-center gap-1">
                            <i class="fas ${trendIcon}"></i> ${pred.trend}
                        </span>
                    </div>
                    <div class="text-[10px] text-emerald-600 font-bold mb-3 flex items-center gap-1">
                        <i class="fas fa-truck-field"></i> ${pred.supplier}
                    </div>
                    <div class="flex justify-between items-center bg-slate-50 p-2 rounded-lg">
                        <span class="text-[9px] text-slate-400 font-bold uppercase">LUX Prediction</span>
                        <span class="text-xs font-extrabold text-[#382546]">₱${pred.forecast}</span>
                    </div>
                    <p class="mt-2 text-[10px] text-slate-500 italic leading-relaxed">Advice: ${pred.advice}</p>
                </div>`;
            });
        }
    } catch (err) {
        console.error("Market Insight Error:", err);
        if (summaryEl) summaryEl.innerHTML = "LUX is currently calculating trends...";
    }
}

