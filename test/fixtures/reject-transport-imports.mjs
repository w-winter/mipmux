export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@earendil-works/pi-') || specifier.startsWith('@modelcontextprotocol/')) {
    throw new Error('Transport dependency imported by deterministic operation');
  }
  return next(specifier, context);
}
