const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 18080;
const ROOT = __dirname;
const CSV_PATH = process.env.CSV_PATH || path.join(__dirname, 'rsvp.csv');
const GOOGLE_SHEET_URL = process.env.GOOGLE_SHEET_URL || 'https://script.google.com/macros/s/AKfycbwjK43w3-pl91WWUSuTVpouU2GOdmwxQCYR2riYzDht41BxVRZHRYpWB2E-72GGibkIyA/exec';
const CSV_HEADER = ['name', 'attendance', 'arrivalTime', 'message', 'updatedAt'];

async function sendToGoogleSheet(row) {
  if (!GOOGLE_SHEET_URL) return;
  try {
    const res = await fetch(GOOGLE_SHEET_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(row),
      redirect: 'follow'
    });
    console.log('[Google Sheet] Đồng bộ thành công');
  } catch (err) {
    console.error('[Google Sheet Error]', err.message);
  }
}

function normalizeName(name) {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeCsv(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseCsv(csv) {
  const records = [];
  let record = [];
  let value = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];
    const nextCharacter = csv[index + 1];

    if (character === '"' && quoted && nextCharacter === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      record.push(value);
      value = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && nextCharacter === '\n') index += 1;
      record.push(value);
      if (record.some((item) => item !== '')) records.push(record);
      record = [];
      value = '';
    } else {
      value += character;
    }
  }

  if (value || record.length) {
    record.push(value);
    records.push(record);
  }

  return records.slice(1).map((values) =>
    Object.fromEntries(CSV_HEADER.map((key, index) => [key, values[index] || '']))
  );
}

function serializeCsv(rows) {
  return [
    CSV_HEADER.join(','),
    ...rows.map((row) => CSV_HEADER.map((key) => escapeCsv(row[key])).join(','))
  ].join('\n') + '\n';
}

async function readRows() {
  try {
    return parseCsv(await fs.readFile(CSV_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function saveRsvp(payload) {
  const rows = await readRows();
  const normalizedName = normalizeName(payload.name);
  const existingIndex = rows.findIndex((row) => normalizeName(row.name) === normalizedName);
  const row = {
    name: payload.name.trim(),
    attendance: payload.attendance,
    arrivalTime: payload.attendance === 'yes' ? payload.arrivalTime : '',
    message: (payload.message || '').trim(),
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    rows[existingIndex] = row;
  } else {
    rows.push(row);
  }

  await fs.mkdir(path.dirname(CSV_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(CSV_PATH, serializeCsv(rows), 'utf8');

  // Async send to Google Sheet (non-blocking)
  sendToGoogleSheet(row).catch((err) => console.error('[Google Sheet Error]', err.message));

  return { updated: existingIndex >= 0, row };
}

async function deleteRsvp(name) {
  const rows = await readRows();
  const normalizedName = normalizeName(name);
  const filteredRows = rows.filter((row) => normalizeName(row.name) !== normalizedName);

  await fs.mkdir(path.dirname(CSV_PATH), { recursive: true }).catch(() => {});
  await fs.writeFile(CSV_PATH, serializeCsv(filteredRows), 'utf8');

  // Async delete from Google Sheet (non-blocking)
  sendToGoogleSheet({ action: 'delete', name }).catch((err) => console.error('[Google Sheet Delete Error]', err.message));
  return { deleted: true };
}

function sendJson(response, statusCode, body) {
  try {
    if (response.headersSent || response.writableEnded) return;
    response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify(body));
  } catch (e) {
    console.error('[sendJson error]', e.message);
  }
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  if (body.length > 100_000) throw new Error('Dữ liệu gửi lên quá lớn.');
  return JSON.parse(body);
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  if (request.method === 'POST' && requestUrl.pathname === '/api/rsvp/delete') {
    try {
      const payload = await readJson(request);
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) return sendJson(response, 400, { error: 'Vui lòng cung cấp tên.' });

      await deleteRsvp(name);
      return sendJson(response, 200, { message: 'Đã xóa xác nhận.' });
    } catch (error) {
      return sendJson(response, 500, { error: error.message || 'Lỗi khi xóa.' });
    }
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/rsvp') {
    try {
      const payload = await readJson(request);
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      const attendance = payload.attendance;
      const arrivalTime = typeof payload.arrivalTime === 'string' ? payload.arrivalTime : '';
      const message = typeof payload.message === 'string' ? payload.message : '';

      if (!name || !['yes', 'no'].includes(attendance)) {
        return sendJson(response, 400, { error: 'Vui lòng nhập tên và chọn trạng thái tham dự.' });
      }
      const [hour, minute] = arrivalTime.split(':').map(Number);
      const validArrivalTime = hour >= 15 && hour <= 17 && minute % 15 === 0 && !(hour === 17 && minute > 30);
      if (attendance === 'yes' && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime) || !validArrivalTime)) {
        return sendJson(response, 400, { error: 'Vui lòng chọn giờ đến từ 15:00 trở đi.' });
      }

      const result = await saveRsvp({ name, attendance, arrivalTime, message });
      const messageText = result.updated
        ? `Đã cập nhật thông tin của ${result.row.name}.`
        : `Đã lưu xác nhận của ${result.row.name}.`;
      return sendJson(response, 200, { updated: result.updated, message: messageText });
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Dữ liệu không hợp lệ.' });
    }
  }

  if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    try {
      const html = await fs.readFile(path.join(ROOT, 'index.html'));
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return response.end(html);
    } catch (error) {
      response.writeHead(500);
      return response.end('Không thể tải trang.');
    }
  }

  if (request.method === 'GET') {
    const mimeTypes = {
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8'
    };
    const relative = path
      .normalize(decodeURIComponent(requestUrl.pathname))
      .replace(/^(\.\.[/\\])+/, '')
      .replace(/^[/\\]+/, '');
    if (!relative || relative.includes('..')) {
      response.writeHead(403);
      return response.end('Forbidden');
    }
    const filePath = path.join(ROOT, relative);
    if (!filePath.startsWith(ROOT + path.sep)) {
      response.writeHead(403);
      return response.end('Forbidden');
    }
    const ext = path.extname(filePath).toLowerCase();
    if (mimeTypes[ext]) {
      try {
        const file = await fs.readFile(filePath);
        response.writeHead(200, { 'Content-Type': mimeTypes[ext] });
        return response.end(file);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          response.writeHead(500);
          return response.end('Server error');
        }
      }
    }
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

// Prevent crash on unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err.message);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
});

const server = http.createServer((request, response) => {
  response.on('error', (err) => console.error('[response error]', err.message));
  handleRequest(request, response).catch((err) => {
    console.error('[request error]', err.message);
    sendJson(response, 500, { error: 'Lỗi máy chủ.' });
  });
});

server.on('error', (err) => console.error('[server error]', err.message));

server.listen(PORT, () => {
  console.log(`\nServer running at http://localhost:${PORT}`);
  console.log(`CSV: ${CSV_PATH}`);
  try {
    const nets = require('os').networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const cfg of iface) {
        if ((cfg.family === 'IPv4' || cfg.family === 4) && !cfg.internal) {
          console.log(`📱 Mobile: http://${cfg.address}:${PORT}`);
        }
      }
    }
  } catch (e) {}
  console.log('');
});
