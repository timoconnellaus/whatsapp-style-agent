// FCM HTTP v1 push, no firebase-admin: mint an OAuth token from the service-account key with WebCrypto
// (RS256 JWT → token exchange), then POST to the v1 send endpoint. Runs on Workers. FAIL-SOFT everywhere —
// a push is a courtesy on top of a message that is already stored in the thread, so nothing here throws.
//
// Config: FCM_SERVICE_ACCOUNT_JSON secret (client_email, private_key, project_id). Absent → no push.
// Every push deep-links with data { type: 'thread', threadId } so the client opens that thread.

import { eq, inArray } from 'drizzle-orm'
import { pushToken, type DB } from './schema'

interface ServiceAccount {
  client_email: string
  private_key: string
  project_id: string
}

export interface PushEnvelope {
  userId: string
  threadId: string
  title: string
  body: string
}

function b64url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s))

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '')
  const bin = atob(body)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)
  return der
}

async function mintAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }
  const unsigned = `${b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlStr(JSON.stringify(claims))}`
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned))
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${b64url(new Uint8Array(sig))}`,
  })
  if (!res.ok) throw new Error(`fcm token exchange ${res.status}: ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

/** One notification per envelope per registered device; prunes tokens FCM reports as gone (404). */
export async function sendPushes(db: DB, serviceAccountJson: string | undefined, envelopes: PushEnvelope[]): Promise<void> {
  if (!serviceAccountJson || !envelopes.length) return
  try {
    const sa = JSON.parse(serviceAccountJson) as ServiceAccount
    if (!sa.client_email || !sa.private_key || !sa.project_id) return
    const userIds = [...new Set(envelopes.map((e) => e.userId))]
    const rows = await db.select().from(pushToken).where(inArray(pushToken.userId, userIds))
    if (!rows.length) return
    const bearer = await mintAccessToken(sa)
    const dead: string[] = []
    for (const envelope of envelopes) {
      for (const row of rows.filter((r) => r.userId === envelope.userId)) {
        const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            message: {
              token: row.token,
              notification: { title: envelope.title, body: envelope.body.length > 160 ? `${envelope.body.slice(0, 159)}…` : envelope.body },
              data: { type: 'thread', threadId: envelope.threadId },
              android: { priority: 'high' },
            },
          }),
        }).catch(() => null)
        if (res?.status === 404) dead.push(row.token)
        else if (res && res.status >= 400) console.error(`fcm send ${res.status}: ${await res.text()}`)
      }
    }
    for (const token of dead) await db.delete(pushToken).where(eq(pushToken.token, token))
  } catch (err) {
    console.error('push failed', String(err))
  }
}
