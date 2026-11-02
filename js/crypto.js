/* ===== VOID — криптография (этап 2) =====
   Всё шифрование выполняется встроенным Web Crypto API браузера.
   - Ключ: PBKDF2 (SHA-256) из мастер-пароля + случайная соль  ->  AES-256-GCM
   - Для КАЖДОГО шифрования генерируется новый случайный IV (12 байт)
   - Ключ создаётся как НЕИЗВЛЕКАЕМЫЙ (extractable: false):
     даже код страницы не сможет прочитать его байты
   - Math.random() не используется нигде */

(function () {
  'use strict';

  const VOID = window.VOID = window.VOID || {};
  const webcrypto = window.crypto;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const DEFAULT_ITERATIONS = 600000; // рекомендация OWASP для PBKDF2-HMAC-SHA256
  const MIN_ITERATIONS = 100000;     // нижняя граница при чтении чужих/импортируемых параметров
  const MAX_ITERATIONS = 5000000;    // верхняя граница (защита от «зависания» из-за подложных данных)
  const SALT_LENGTH = 16;            // байт
  const IV_LENGTH = 12;              // байт — стандартный размер для AES-GCM

  /** Есть ли в этом окружении всё необходимое (нужен HTTPS или localhost). */
  function isSupported() {
    return !!(webcrypto && webcrypto.subtle && typeof webcrypto.getRandomValues === 'function');
  }

  /** Криптографически стойкие случайные байты. */
  function randomBytes(length) {
    const bytes = new Uint8Array(length);
    webcrypto.getRandomValues(bytes);
    return bytes;
  }

  /** Случайный идентификатор записи: 16 байт -> 32 hex-символа. */
  function randomId() {
    return Array.from(randomBytes(16), b => b.toString(16).padStart(2, '0')).join('');
  }

  /** Байты -> строка Base64 (понадобится для резервных копий в JSON). */
  function toB64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000; // по частям, чтобы не переполнить стек на больших данных
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /** Строка Base64 -> байты. Бросает ошибку при некорректной строке. */
  function fromB64(str) {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /** Получение ключа AES-256-GCM из пароля. Самая «тяжёлая» операция (около 0.5–2 с на телефоне). */
  async function deriveKey(password, salt, iterations) {
    if (!isSupported()) throw new Error('CRYPTO_UNSUPPORTED');
    if (typeof password !== 'string' || password.length === 0) throw new Error('EMPTY_PASSWORD');
    const saltBytes = new Uint8Array(salt);
    if (saltBytes.length < SALT_LENGTH) throw new Error('BAD_SALT');
    if (!Number.isInteger(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
      throw new Error('BAD_ITERATIONS');
    }

    // NFKC: одинаковые по виду символы Юникода дают один и тот же ключ на любой клавиатуре
    const passwordBytes = encoder.encode(password.normalize('NFKC'));
    const baseKey = await webcrypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);

    return webcrypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,                    // extractable: false — ключ нельзя «достать» из памяти
      ['encrypt', 'decrypt']
    );
  }

  /** Шифрует любой JSON-совместимый объект.
      aad — «связанные данные» (например, "journal:ID"): запись нельзя незаметно
      перенести под другой идентификатор или в другой раздел. */
  async function encrypt(key, value, aad) {
    const iv = randomBytes(IV_LENGTH); // новый IV на каждую операцию
    const params = { name: 'AES-GCM', iv: iv, tagLength: 128 };
    if (aad) params.additionalData = encoder.encode(aad);
    const data = await webcrypto.subtle.encrypt(params, key, encoder.encode(JSON.stringify(value)));
    return { iv: iv, data: data };
  }

  /** Расшифровывает. При неверном ключе или повреждённых данных бросает DECRYPT_FAILED
      (режим GCM сам проверяет целостность). */
  async function decrypt(key, iv, data, aad) {
    const params = { name: 'AES-GCM', iv: new Uint8Array(iv), tagLength: 128 };
    if (aad) params.additionalData = encoder.encode(aad);
    let plain;
    try {
      plain = await webcrypto.subtle.decrypt(params, key, data);
    } catch (e) {
      throw new Error('DECRYPT_FAILED');
    }
    return JSON.parse(decoder.decode(plain));
  }

  VOID.crypto = {
    DEFAULT_ITERATIONS, SALT_LENGTH, IV_LENGTH,
    isSupported, randomBytes, randomId, toB64, fromB64,
    deriveKey, encrypt, decrypt
  };
})();