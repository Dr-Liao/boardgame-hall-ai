// 更新清单签名（ed25519）。
//
// 清单文件是一个信封：{ "keyId": "...", "payload": "<JSON 字符串>", "signature": "<base64>" }。
// 签名覆盖 payload 原文，校验通过后才解析 payload；大厅与游戏的发布清单共用同一套信任公钥。
// 公钥登记在 lib/update-keys.json（tools/release/keygen.mjs 生成），私钥只存放在 GitHub Secrets。

import fs from 'node:fs'
import { KeyObject, createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

export function keyIdOf(publicKey) {
  const key = publicKey instanceof KeyObject && publicKey.type === 'public' ? publicKey : createPublicKey(publicKey)
  const der = key.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(der).digest('hex').slice(0, 16)
}

/** 读取内置信任公钥：[{ id, spki }]，spki 为 base64 DER。 */
export function loadTrustedKeys(file = new URL('./update-keys.json', import.meta.url)) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return (Array.isArray(data.keys) ? data.keys : []).filter(key => key && typeof key.spki === 'string')
  } catch {
    return []
  }
}

export function signEnvelope(payload, privateKeyPem) {
  const key = createPrivateKey(privateKeyPem)
  const text = JSON.stringify(payload)
  return JSON.stringify({
    keyId: keyIdOf(createPublicKey(key)),
    payload: text,
    signature: sign(null, Buffer.from(text), key).toString('base64'),
  }, null, 2) + '\n'
}

/** 校验信封并返回 payload 对象；任何问题都抛出可直接展示的错误。 */
export function verifyEnvelope(text, keys) {
  if (!keys?.length) throw new Error('尚未配置更新签名公钥（见 docs/updates.md）')
  let envelope
  try { envelope = JSON.parse(text) } catch { throw new Error('更新清单不是有效的 JSON') }
  if (!envelope || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('更新清单缺少签名')
  const candidates = keys.filter(key => !envelope.keyId || !key.id || key.id === envelope.keyId)
  const signature = Buffer.from(envelope.signature, 'base64')
  const trusted = candidates.some(key => {
    try {
      const publicKey = createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' })
      return verify(null, Buffer.from(envelope.payload), publicKey, signature)
    } catch {
      return false
    }
  })
  if (!trusted) throw new Error('更新清单签名无效，已拒绝')
  return JSON.parse(envelope.payload)
}
