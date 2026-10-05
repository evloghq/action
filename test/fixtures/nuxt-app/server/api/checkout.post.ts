export default defineEventHandler(async (event) => {
  const log = useLogger(event)
  const body = await readBody(event)
  log.set({ user: { id: body.userId }, cart: { items: body.items.length } })
  return { ok: true }
})
