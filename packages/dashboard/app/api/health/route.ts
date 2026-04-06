export async function GET() {
  return Response.json({
    status: "ok",
    service: "gtmship-dashboard",
    version: "0.1.0",
  });
}
