

const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const PORT = Number(process.env.PORT) || 3001;
const MAX_PARTICIPANTS = 2;

const app = express();
const server = http.createServer(app);

// public klasöründeki dosyaları sun.
app.use(express.static(path.join(__dirname, 'public')));

// Ana sayfayı aç.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// WebSocket ve web sayfası aynı sunucuyu kullanacak.
const wss = new WebSocket.Server({ server });

server.listen(PORT, () => {
  console.log(`Connecta http://localhost:${PORT} adresinde çalışıyor.`);
});

const rooms = Object.create(null);

function leaveRoom(ws) {
  if (!ws.room || !rooms[ws.room]) return;

  const roomId = ws.room;

  rooms[roomId] = rooms[roomId].filter(
    client => client !== ws
  );

  rooms[roomId].forEach(client => {
    sendMessage(client, {
      type: 'user-left',
      name: ws.name
    });
  });

  if (rooms[roomId].length === 0) {
    delete rooms[roomId];
  } else if (rooms[roomId].length === 1) {
    sendMessage(rooms[roomId][0], {
      type: 'role',
      role: 'caller'
    });
  }

  ws.room = null;
  ws.name = null;
}

console.log(`WebSocket sunucusu ${PORT} portunda çalışıyor...`);

// WebSocket bağlantısına güvenli biçimde mesaj gönderir.
function sendMessage(client, data) {
  if (client.readyState === WebSocket.OPEN) {
    client.send(JSON.stringify(data));
  }
}

// Aynı odadaki diğer kullanıcıya mesaj gönderir.
function sendToOtherParticipants(sender, data) {
  const room = rooms[sender.room];

  if (!room) return;

  room.forEach(client => {
    if (client !== sender) {
      sendMessage(client, data);
    }
  });
}

wss.on('connection', ws => {
  ws.id = require('crypto').randomUUID();
  ws.room = null;
  ws.name = null;

  console.log(`Yeni istemci bağlandı: ${ws.id}`);

  ws.on('message', message => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch (error) {
      sendMessage(ws, {
        type: 'error',
        message: 'Geçersiz mesaj formatı.'
      });
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      sendMessage(ws, {
        type: 'error',
        message: 'Geçersiz mesaj.'
      });
      return;
    }

    switch (data.type) {
      case 'join': {
        const room = data.room;
        const name = data.name;

        // Kullanıcı ve oda bilgilerini doğrula.
        if (
          typeof room !== 'string' ||
          typeof name !== 'string' ||
          !room.trim() ||
          !name.trim() ||
          room.length > 50 ||
          name.length > 50
        ) {
          sendMessage(ws, {
            type: 'error',
            message: 'Geçerli bir oda numarası ve kullanıcı adı girin.'
          });
          break;
        }

        // Aynı bağlantının tekrar odaya katılmasını engelle.
        if (ws.room !== null) {
          sendMessage(ws, {
            type: 'error',
            message: 'Zaten bir odaya katıldınız.'
          });
          break;
        }

        const roomId = room.trim();
        const userName = name.trim();

        if (!rooms[roomId]) {
          rooms[roomId] = [];
        }

        // Mevcut uygulama iki katılımcıyı destekliyor.
        if (rooms[roomId].length >= MAX_PARTICIPANTS) {
          sendMessage(ws, {
            type: 'room-full',
            message: 'Bu oda dolu. En fazla 2 kişi katılabilir.'
          });
          break;
        }

        const isFirstClient = rooms[roomId].length === 0;

        ws.room = roomId;
        ws.name = userName;

        rooms[roomId].push(ws);

        console.log(
          `${ws.name} ${ws.room} odasına katıldı. Rol: ${
            isFirstClient ? 'caller' : 'callee'
          }`
        );

        // Katılan kullanıcıya rolünü bildir.
        sendMessage(ws, {
          type: 'role',
          role: isFirstClient ? 'caller' : 'callee'
        });

        // Diğer katılımcıya haber ver.
        sendToOtherParticipants(ws, {
          type: 'user-joined',
          name: ws.name
        });

        
      // İkinci kullanıcı katıldığında iki taraf da
      // karşısındaki katılımcının adını öğrensin.
      if (!isFirstClient) {
        const callerClient = rooms[roomId][0];

        // Yeni katılan B kullanıcısına A'nın adını bildir.
        sendMessage(ws, {
          type: 'user-joined',
          name: callerClient.name
        });

        // İlk katılan A kullanıcısı WebRTC teklifini oluştursun.
        sendMessage(callerClient, {
          type: 'peer-ready',
          peerName: ws.name
        });
      }


        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        // Sadece odaya katılmış kullanıcılar sinyal gönderebilir.
        if (!ws.room || !rooms[ws.room]) {
          sendMessage(ws, {
            type: 'error',
            message: 'Önce bir odaya katılmalısınız.'
          });
          break;
        }

        // WebRTC sinyalini aynı odadaki diğer kullanıcıya ilet.
        sendToOtherParticipants(ws, data);
        break;
      }

      case 'leave': {
      leaveRoom(ws);
      break;
    }

      case 'chat-message': {
        if (!ws.room || !rooms[ws.room]) {
          sendMessage(ws, {
            type: 'error',
            message: 'Mesaj göndermek için bir odaya katılmalısınız.'
          });
          break;
        }

        if (
          typeof data.message !== 'string' ||
          !data.message.trim() ||
          data.message.length > 2000
        ) {
          sendMessage(ws, {
            type: 'error',
            message: 'Mesaj boş olamaz veya 2000 karakteri geçemez.'
          });
          break;
        }

        sendToOtherParticipants(ws, {
          type: 'chat-message',
          name: ws.name,
          message: data.message.trim()
        });

        break;
      }

      default:
        sendMessage(ws, {
          type: 'error',
          message: 'Desteklenmeyen mesaj türü.'
        });
        break;
    }
  });

  ws.on('close', () => {
  console.log(
    `${ws.name || ws.id} istemcisinin bağlantısı kesildi.`
  );

  leaveRoom(ws);
});

  ws.on('error', error => {
    console.error(
      `WebSocket hatası (${ws.name || ws.id}):`,
      error.message
    );
  });
});
