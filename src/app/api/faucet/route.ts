import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimits, recordClaim, getTotalDistributed } from '@/lib/rateLimit'

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/
const RPC_URL = process.env.RPC_URL ?? 'http://103.175.219.233:8545/rpc'

function getClientIP(request: NextRequest): string {
  const realIP = request.headers.get('x-real-ip')
  if (realIP) return realIP.trim()
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0].trim()
  return '127.0.0.1'
}

async function fetchFaucetBalance(): Promise<number> {
  const faucetAddress = process.env.FAUCET_ADDRESS
  if (!faucetAddress) return 0
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'sentrix_getBalance',
        params: [faucetAddress],
        id: 1,
      }),
      signal: AbortSignal.timeout(3_000),
    })
    const data = await res.json() as { result?: string }
    const raw = data.result ?? '0'
    // result may be hex ("0x...") or decimal string
    const sentri = raw.startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
    return isNaN(sentri) ? 0 : sentri / 100_000_000 // 1 SRX = 100,000,000 sentri
  } catch {
    return 0
  }
}

// POST /api/faucet — request tokens
export async function POST(request: NextRequest) {
  try {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 })
    }

    const { address } = body as { address?: string }

    if (!address || typeof address !== 'string') {
      return NextResponse.json({ success: false, error: 'Missing wallet address' }, { status: 400 })
    }

    if (!ADDRESS_REGEX.test(address)) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet address (must be 0x + 40 hex characters)' },
        { status: 400 }
      )
    }

    // Check rate limits — IP AND address
    const ip = getClientIP(request)
    const { allowed, cooldownSeconds, reason } = checkRateLimits(ip, address)

    if (!allowed) {
      const msg =
        reason === 'address'
          ? 'This address already claimed today — come back in 24h'
          : 'Rate limit: 1 request per 24 hours per IP address'
      return NextResponse.json(
        { success: false, error: msg, cooldown: cooldownSeconds },
        { status: 429 }
      )
    }

    // Validate server config
    const faucetPrivateKey = process.env.FAUCET_PRIVATE_KEY
    const faucetAddress = process.env.FAUCET_ADDRESS
    const amount = parseInt(process.env.FAUCET_AMOUNT ?? '10', 10)

    if (!faucetPrivateKey || faucetPrivateKey === 'FILL_IN_FROM_GENESIS_WALLETS') {
      console.error('[faucet] FAUCET_PRIVATE_KEY not configured')
      return NextResponse.json(
        { success: false, error: 'Faucet not configured — contact admin' },
        { status: 503 }
      )
    }

    // Send SRX via Sentrix JSON-RPC (private_key never leaves server)
    let rpcRes: Response
    try {
      rpcRes = await fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'sentrix_sendTransaction',
          params: [{ from: faucetAddress, to: address, amount, private_key: faucetPrivateKey }],
          id: 1,
        }),
        signal: AbortSignal.timeout(15_000),
      })
    } catch (err) {
      console.error('[faucet] RPC unreachable:', err)
      return NextResponse.json(
        { success: false, error: 'Sentrix node unreachable — try again later' },
        { status: 503 }
      )
    }

    let rpcData: { result?: string; error?: { message?: string } }
    try {
      rpcData = await rpcRes.json()
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid response from Sentrix node' },
        { status: 502 }
      )
    }

    if (rpcData.error) {
      console.error('[faucet] RPC error:', rpcData.error)
      return NextResponse.json(
        { success: false, error: rpcData.error.message ?? 'Transaction rejected by node' },
        { status: 400 }
      )
    }

    const txHash = rpcData.result ?? ''

    // Record after confirmed success
    recordClaim(ip, address, amount)
    console.info(`[faucet] Sent ${amount} SRX → ${address} | tx: ${txHash} | ip: ${ip}`)

    return NextResponse.json({ success: true, txHash })
  } catch (err) {
    console.error('[faucet] Unexpected error:', err)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}

// GET /api/faucet — faucet stats (no sensitive data)
export async function GET() {
  const [balance, totalDistributed] = await Promise.all([
    fetchFaucetBalance(),
    Promise.resolve(getTotalDistributed()),
  ])

  return NextResponse.json({
    amount: parseInt(process.env.FAUCET_AMOUNT ?? '10', 10),
    chainId: parseInt(process.env.NEXT_PUBLIC_CHAIN_ID ?? '7119', 10),
    faucetAddress: process.env.FAUCET_ADDRESS ?? '',
    cooldownHours: 24,
    balance,
    totalDistributed,
    status: 'active',
  })
}
