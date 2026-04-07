/**
 * Fetch API service for LegalEdge CRM backend.
 * Base URL defaults to '/api' (Vite proxy) and can be overridden with VITE_API_BASE_URL.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '');
const DEV_DIRECT_BASE_URLS = ['http://localhost:8000/api', 'http://127.0.0.1:8000/api'];
const SHOULD_RETRY_DIRECT_IN_DEV = import.meta.env.DEV && BASE_URL === '/api';

function buildUrlFrom(baseUrl, path) {
  return `${baseUrl}${path}`;
}

function appendQuery(path, params) {
  if (!params || typeof params !== 'object') return path;
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    search.append(key, String(value));
  });
  const qs = search.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

function mapNetworkError(err, baseUrl = BASE_URL) {
  if (err?.name === 'TypeError' && /fetch/i.test(err?.message || '')) {
    return new Error(
      `Failed to reach API at "${baseUrl}". Start backend server or set VITE_API_BASE_URL correctly.`
    );
  }
  return err;
}

function extractFirstErrorMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = extractFirstErrorMessage(item);
      if (message) return message;
    }
    return '';
  }
  if (typeof value === 'object') {
    const priorityKeys = ['error', 'detail', 'message', 'errors', 'non_field_errors'];
    for (const key of priorityKeys) {
      if (key in value) {
        const message = extractFirstErrorMessage(value[key]);
        if (message) return message;
      }
    }
    for (const nestedValue of Object.values(value)) {
      const message = extractFirstErrorMessage(nestedValue);
      if (message) return message;
    }
  }
  return '';
}

function looksLikeHtmlDocument(text = '') {
  const sample = String(text).trim().slice(0, 500).toLowerCase();
  return sample.includes('<!doctype html')
    || sample.includes('<html')
    || sample.includes('<head')
    || sample.includes('<body');
}

function summarizeHtmlError(rawText, response, fallback = 'Request failed') {
  const statusPart = response?.status ? ` (HTTP ${response.status})` : '';
  const lower = String(rawText || '').toLowerCase();

  if (lower.includes('debug = true') || lower.includes('technical 500 response') || lower.includes('traceback')) {
    return `Server error${statusPart}. Django returned a debug HTML page instead of JSON.`;
  }

  return `${fallback}${statusPart}. Server returned HTML instead of JSON.`;
}

async function readErrorPayload(response) {
  const rawText = await response.text().catch(() => '');
  if (!rawText) return {};
  if (looksLikeHtmlDocument(rawText)) {
    return {
      message: summarizeHtmlError(rawText, response),
      rawText,
      isHtml: true,
    };
  }
  try {
    return JSON.parse(rawText);
  } catch {
    return { message: rawText };
  }
}

function buildHttpErrorMessage(errorData, response, fallback = 'Request failed') {
  const extracted = extractFirstErrorMessage(errorData);
  if (extracted) return extracted;

  if (response?.status) {
    return `${fallback} (HTTP ${response.status})`;
  }

  return fallback;
}

async function requestWithDevFallback(path, options = {}, requestState = {}) {
  const {
    baseUrl = BASE_URL,
    fallbackIndex = -1,
    retryCount = 0,
  } = requestState;
  
  const MAX_RETRIES = 2;
  const method = (options.method || 'GET').toUpperCase();

  try {
    const response = await fetch(buildUrlFrom(baseUrl, path), options);
    
    // Fallback logic for DEV mode only
    const shouldRetryOn500 =
      SHOULD_RETRY_DIRECT_IN_DEV &&
      baseUrl === BASE_URL &&
      method === 'GET' &&
      response.status >= 500 &&
      retryCount < MAX_RETRIES;

    if (shouldRetryOn500) {
      const firstDirectBase = DEV_DIRECT_BASE_URLS[0];
      if (!firstDirectBase) return response;
      return requestWithDevFallback(path, options, {
        baseUrl: firstDirectBase,
        fallbackIndex: 0,
        retryCount: retryCount + 1,
      });
    }

    return response;
  } catch (err) {
    const isNetworkError = err?.name === 'TypeError' || /fetch/i.test(err?.message || '');
    
    if (SHOULD_RETRY_DIRECT_IN_DEV && isNetworkError && retryCount < MAX_RETRIES) {
      if (baseUrl === BASE_URL) {
        const firstDirectBase = DEV_DIRECT_BASE_URLS[0];
        if (firstDirectBase) {
          return requestWithDevFallback(path, options, {
            baseUrl: firstDirectBase,
            fallbackIndex: 0,
            retryCount: retryCount + 1,
          });
        }
      } else {
        const nextDirectBase = DEV_DIRECT_BASE_URLS[fallbackIndex + 1];
        if (nextDirectBase) {
          return requestWithDevFallback(path, options, {
            baseUrl: nextDirectBase,
            fallbackIndex: fallbackIndex + 1,
            retryCount: retryCount + 1,
          });
        }
      }
    }

    throw mapNetworkError(err, baseUrl);
  }
}

// â”€â”€ Token helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function getToken() {
  return localStorage.getItem('crm_token') || sessionStorage.getItem('crm_token');
}

function getRefreshToken() {
  return localStorage.getItem('crm_refresh') || sessionStorage.getItem('crm_refresh');
}

function storeTokens(access, refresh, remember = false) {
  const storage = remember ? localStorage : sessionStorage;
  const otherStorage = remember ? sessionStorage : localStorage;
  // Keep a single active auth source to avoid session/local token mismatches.
  otherStorage.removeItem('crm_token');
  otherStorage.removeItem('crm_refresh');
  otherStorage.removeItem('crm_user');
  storage.setItem('crm_token', access);
  if (refresh) storage.setItem('crm_refresh', refresh);
}

function clearTokens() {
  ['crm_token', 'crm_refresh', 'crm_user'].forEach(k => {
    localStorage.removeItem(k);
    sessionStorage.removeItem(k);
  });
}

// â”€â”€ Raw fetch wrapper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await requestWithDevFallback(path, {
    ...options,
    headers,
  });

  // Handle 401 â€“ auto refresh once
  if (response.status === 401 && !options._retry) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      return apiFetch(path, { ...options, _retry: true });
    }
    clearTokens();
    const unauthorizedError = new Error('Unauthorized');
    unauthorizedError.status = 401;
    throw unauthorizedError;
  }

  if (!response.ok) {
    const errorData = await readErrorPayload(response);
    const msg = buildHttpErrorMessage(errorData, response);
    throw new Error(msg);
  }

  // 204 No Content
  if (response.status === 204) return null;
  // Some endpoints may return an empty body or HTML (e.g., server error pages).
  // Guard against calling response.json() on an empty or non-JSON response.
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    // Try to read text. If empty, return null. If HTML, surface a helpful error.
    const rawText = await response.text().catch(() => '');
    if (!rawText) return null;
    if (looksLikeHtmlDocument(rawText)) {
      // Provide a readable error for HTML debug pages
      const errMsg = summarizeHtmlError(rawText, response, 'Unexpected server response');
      const err = new Error(errMsg);
      err.status = response.status;
      throw err;
    }
    // Try to parse text as JSON, fallback to returning raw text
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }

  return response.json();
}

async function blobFetch(path, options = {}) {
  const token = getToken();
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers || {}),
  };
  const response = await requestWithDevFallback(path, {
    ...options,
    headers,
  });
  if (!response.ok) {
    const errorData = await readErrorPayload(response);
    const msg = buildHttpErrorMessage(errorData, response);
    throw new Error(msg);
  }
  return response.blob();
}

const api = {
  get: async (path, options = {}) => {
    const finalPath = appendQuery(path, options.params);
    if (options.responseType === 'blob') {
      const data = await blobFetch(finalPath, { method: 'GET' });
      return { data };
    }
    const data = await apiFetch(finalPath, { method: 'GET' });
    return { data };
  },
  post: async (path, payload = {}) => {
    const data = await apiFetch(path, { method: 'POST', body: JSON.stringify(payload) });
    return { data };
  },
  patch: async (path, payload = {}) => {
    const data = await apiFetch(path, { method: 'PATCH', body: JSON.stringify(payload) });
    return { data };
  },
  delete: async (path) => {
    const data = await apiFetch(path, { method: 'DELETE' });
    return { data };
  },
};

let refreshInFlight = null;

async function tryRefreshToken() {
  if (refreshInFlight) return refreshInFlight;

  const refresh = getRefreshToken();
  if (!refresh) return false;

  refreshInFlight = (async () => {
    try {
      const res = await requestWithDevFallback('/auth/refresh/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      // Keep in same storage as original
      const inLocal = !!localStorage.getItem('crm_refresh');
      storeTokens(data.access, data.refresh, inLocal);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const authAPI = {
  login: async (email, password, remember = false) => {
    const res = await requestWithDevFallback('/auth/login/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await readErrorPayload(res);
      throw new Error(buildHttpErrorMessage(err, res, 'Invalid credentials.'));
    }
    const data = await res.json();
    storeTokens(data.access, data.refresh, remember);
    const storage = remember ? localStorage : sessionStorage;
    storage.setItem('crm_user', JSON.stringify(data.user));
    if (data?.user?.role) storage.setItem('crm_role', data.user.role);
    return data.user;
  },

  signup: async (payload) => {
    const res = await requestWithDevFallback('/auth/signup/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await readErrorPayload(res);
      throw new Error(buildHttpErrorMessage(err, res, 'Signup failed'));
    }
    const data = await res.json();
    storeTokens(data.access, data.refresh, false);
    sessionStorage.setItem('crm_user', JSON.stringify(data.user));
    if (data?.user?.role) sessionStorage.setItem('crm_role', data.user.role);
    return data.user;
  },

  me: () => {
    if (!getToken()) {
      const noTokenError = new Error('No access token found. Please login first.');
      noTokenError.status = 401;
      throw noTokenError;
    }
    return apiFetch('/auth/me/');
  },

  logout: () => {
    clearTokens();
  },
};

// â”€â”€ Dashboard â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const dashboardAPI = {
  admin: () => apiFetch('/dashboard/admin/'),
  manager: () => apiFetch('/dashboard/manager/'),
  user: () => apiFetch('/dashboard/user/'),
  getStats: () => api.get('/dashboard/stats/'),
  getRevenueChart: () => api.get('/dashboard/revenue-chart/'),
  getLeadsChart: () => api.get('/dashboard/leads-chart/'),
  getPipeline: () => api.get('/dashboard/deals-pipeline/'),
  getRecentActivity: () => api.get('/dashboard/recent-activity/'),
};

// â”€â”€ Generic CRUD factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function crudAPI(resource) {
  return {
    list: (params = '') => apiFetch(`/${resource}/${params}`),
    get: (id) => apiFetch(`/${resource}/${id}/`),
    create: (data) => apiFetch(`/${resource}/`, { method: 'POST', body: JSON.stringify(data) }),
    update: (id, data) => apiFetch(`/${resource}/${id}/`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => apiFetch(`/${resource}/${id}/`, { method: 'DELETE' }),
  };
}

export const contactsAPI = crudAPI('contacts');
export const leadsAPI = crudAPI('leads');
export const dealsAPI = crudAPI('deals');
export const tasksAPI = crudAPI('tasks');
export const companiesAPI = crudAPI('companies');
export const ticketsAPI = crudAPI('tickets');
export const callsAPI = crudAPI('calls');
export const meetingsAPI = crudAPI('meetings');
export const activitiesAPI = crudAPI('activities');
export const notesAPI = crudAPI('notes');
export const emailAPI = {
  getInbox: () => api.get('/inbox/'),
  getInboxWithSync: () => api.get('/inbox/', { params: { sync: 1 } }),
  getThreads: () => api.get('/inbox/threads/'),
  markAsRead: (id) => api.patch(`/inbox/${id}/read/`),
  deleteMsg: (id) => api.delete(`/inbox/${id}/`),
  getSent: () => api.get('/email/sent/'),
  getAccounts: () => api.get('/email/accounts/'),
  getConnectUrl: (provider) => api.post('/email/connect-url/', { provider }),
  disconnectAccount: (id) => api.post(`/email/accounts/${id}/disconnect/`),
  syncInbox: (payload = {}) => api.post('/email/sync/', payload),
  send: (payload) => api.post('/email/send/', payload),
};

Object.assign(leadsAPI, {
  getAll: (params) => api.get('/leads/', { params }),
  getOne: (id) => api.get(`/leads/${id}/`),
  create: (data) => api.post('/leads/', data),
  update: (id, d) => api.patch(`/leads/${id}/`, d),
  delete: (id) => api.delete(`/leads/${id}/`),
  getNotes: (id) => api.get(`/leads/${id}/notes/`),
  addNote: (id, d) => api.post(`/leads/${id}/notes/`, d),
  export: () => api.get('/leads/export/', { responseType: 'blob' }),
});

Object.assign(dealsAPI, {
  getAll: (params) => api.get('/deals/', { params }),
  getOne: (id) => api.get(`/deals/${id}/`),
  create: (data) => api.post('/deals/', data),
  update: (id, d) => api.patch(`/deals/${id}/`, d),
  updateStage: (id, stage) => api.patch(`/deals/${id}/`, { stage }),
  delete: (id) => api.delete(`/deals/${id}/`),
  getNotes: (id) => api.get(`/deals/${id}/notes/`),
  addNote: (id, d) => api.post(`/deals/${id}/notes/`, d),
});

Object.assign(contactsAPI, {
  getAll: (params) => api.get('/contacts/', { params }),
  getOne: (id) => api.get(`/contacts/${id}/`),
  create: (data) => api.post('/contacts/', data),
  update: (id, d) => api.patch(`/contacts/${id}/`, d),
  delete: (id) => api.delete(`/contacts/${id}/`),
});

Object.assign(companiesAPI, {
  getAll: (params) => api.get('/companies/', { params }),
  create: (data) => api.post('/companies/', data),
  update: (id, d) => api.patch(`/companies/${id}/`, d),
  delete: (id) => api.delete(`/companies/${id}/`),
});

Object.assign(tasksAPI, {
  getAll: (params) => api.get('/tasks/', { params }),
  create: (data) => api.post('/tasks/', data),
  update: (id, d) => api.patch(`/tasks/${id}/`, d),
  delete: (id) => api.delete(`/tasks/${id}/`),
  markDone: (id) => api.patch(`/tasks/${id}/`, { status: 'Done' }),
});

Object.assign(ticketsAPI, {
  getAll: (params) => api.get('/tickets/', { params }),
  create: (data) => api.post('/tickets/', data),
  update: (id, d) => api.patch(`/tickets/${id}/`, d),
  delete: (id) => api.delete(`/tickets/${id}/`),
});

export const notificationsAPI = {
  getAll: () => api.get('/notifications/'),
  markRead: (id) => api.patch(`/notifications/${id}/read/`),
  markAllRead: () => api.patch('/notifications/mark-all-read/'),
  getUnreadCount: () => api.get('/notifications/unread-count/'),
};

export const marketingCampaignsAPI = crudAPI('marketing-campaigns');
export const marketingAdsAPI = crudAPI('marketing-ads');
export const marketingFormsAPI = crudAPI('marketing-forms');
export const marketingEventsAPI = crudAPI('marketing-events');
export const marketingSocialAPI = crudAPI('marketing-social');
export const marketingBuyerIntentAPI = crudAPI('marketing-buyer-intent');
export const marketingLeadScoringAPI = crudAPI('marketing-lead-scoring');
export const designFilesAPI = crudAPI('design-files');

export const usersAPI = crudAPI('users');

export { storeTokens, clearTokens, getToken };

