import packageJson from "../../../package.json";

export async function GET() {
  return Response.json({
    status: "ok",
    service: "gtmship-dashboard",
    version: packageJson.version,
  });
}
