/**
 * SUB-Project Dashboard - Main JavaScript
 * Database: SUB-DB (phpMyAdmin)
 */

let currentUser = null;
let currentPage = 'dashboard';
const API_BASE = '../backend/api/';

function initDashboard() {
    updateCurrentDate();
    setTimeout(() => checkAuthentication(), 500);
    setupEventListeners();
}

function updateCurrentDate() {
    const now = new Date();
    document.getElementById('currentDate').textContent = now.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setupEventListeners() {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function(e) {
            e.preventDefault();
            navigateTo(this.dataset.page);
        });
    });
    document.getElementById('searchInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') performSearch();
    });
}

function checkAuthentication() {
    const savedUser = localStorage.getItem('sub_currentUser');
    const savedToken = localStorage.getItem('sub_authToken');
    if (savedUser && savedToken) {
        verifyToken(savedToken).then(valid => {
            if (valid) {
                currentUser = JSON.parse(savedUser);
                showApp();
            } else { showLogin(); }
        });
    } else { showLogin(); }
}

function showLogin() {
    document.getElementById('loadingOverlay').classList.add('hidden');
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('loginModal').style.display = 'none';
    document.getElementById('loadingOverlay').classList.add('hidden');
    document.getElementById('app').style.display = 'flex';
    document.getElementById('currentUser').textContent = currentUser.full_name || currentUser.username;
    document.getElementById('dropdownUserName').textContent = currentUser.full_name || currentUser.username;
    loadDashboardData();
}

async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const errorDiv = document.getElementById('loginError');
    const submitBtn = e.target.querySelector('button[type="submit"]');
    
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Logging in...';
    
    try {
        const response = await fetch(API_BASE + 'auth.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'login', username, password })
        });
        const data = await response.json();
        
        if (data.success) {
            localStorage.setItem('sub_currentUser', JSON.stringify(data.user));
            localStorage.setItem('sub_authToken', data.token);
            currentUser = data.user;
            showApp();
            showToast('success', 'Login successful!');
        } else {
            errorDiv.textContent = data.message || 'Invalid credentials';
            errorDiv.style.display = 'block';
        }
    } catch (error) {
        errorDiv.textContent = 'Connection error. Check XAMPP is running.';
        errorDiv.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Login';
    }
}

async function verifyToken(token) {
    try {
        const response = await fetch(API_BASE + 'auth.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'verify', token })
        });
        const data = await response.json();
        return data.success;
    } catch { return false; }
}

function logout() {
    localStorage.removeItem('sub_currentUser');
    localStorage.removeItem('sub_authToken');
    currentUser = null;
    document.getElementById('app').style.display = 'none';
    document.getElementById('loginModal').style.display = 'flex';
    document.getElementById('username').value = '';
    document.getElementById('password').value = '';
    showToast('info', 'Logged out successfully.');
}

function togglePassword() {
    const input = document.getElementById('password');
    const icon = document.querySelector('.toggle-password i');
    if (input.type === 'password') {
        input.type = 'text';
        icon.classList.replace('fa-eye', 'fa-eye-slash');
    } else {
        input.type = 'password';
        icon.classList.replace('fa-eye-slash', 'fa-eye');
    }
}

function navigateTo(page) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    const target = document.getElementById('page-' + page);
    if (target) target.style.display = 'block';
    
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    const active = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (active) active.classList.add('active');
    
    currentPage = page;
    
    switch(page) {
        case 'dashboard': loadDashboardData(); break;
        case 'products': loadProducts(); break;
        case 'sales': loadSales(); break;
        case 'customers': loadCustomers(); break;
        case 'stock': loadStock(); break;
        case 'partners': loadPartners(); break;
        case 'profit': loadProfitRecords(); break;
        case 'users': loadUsers(); break;
        case 'expenditures': loadExpenses(); break;
    }
}

function formatNumber(num) {
    return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
