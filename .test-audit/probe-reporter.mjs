// Probe the node:test reporter event shape (what identifies a test file).
export default async function* probe(source) {
  let count = 0
  for await (const event of source) {
    if (count++ < 30) {
      const data = event.data || {}
      console.log(JSON.stringify({
        type: event.type,
        name: data.name,
        nesting: data.nesting,
        file: data.file,
        keys: Object.keys(data).slice(0, 20),
        duration: data.details?.duration_ms,
      }))
    }
    yield ''
  }
}
