import { NextResponse } from "next/server";

const AUTH_SERVICE_URL =
  process.env.AUTH_SERVICE_URL ||
  process.env.NEXT_PUBLIC_AUTH_URL ||
  "http://localhost:4000";

export const dynamic = "force-dynamic";

function buildUpstreamUrl(path: string[], request: Request): string {
  const upstreamUrl = new URL(
    `/${path.map((segment) => encodeURIComponent(segment)).join("/")}`,
    `${AUTH_SERVICE_URL.replace(/\/+$/, "")}/`
  );
  upstreamUrl.search = new URL(request.url).search;
  return upstreamUrl.toString();
}

function buildProxyHeaders(request: Request): Headers {
  const headers = new Headers();

  for (const headerName of [
    "accept",
    "authorization",
    "content-type",
    "cookie",
  ]) {
    const value = request.headers.get(headerName);
    if (value) {
      headers.set(headerName, value);
    }
  }

  return headers;
}

async function proxyRequest(
  request: Request,
  { params }: { params: { path: string[] } }
) {
  try {
    const upstreamResponse = await fetch(buildUpstreamUrl(params.path, request), {
      method: request.method,
      headers: buildProxyHeaders(request),
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.text(),
      cache: "no-store",
      redirect: "manual",
    });

    const responseHeaders = new Headers();
    for (const headerName of ["content-type", "location", "set-cookie"]) {
      const value = upstreamResponse.headers.get(headerName);
      if (value) {
        responseHeaders.set(headerName, value);
      }
    }

    return new NextResponse(await upstreamResponse.text(), {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reach auth service.",
      },
      { status: 502 }
    );
  }
}

export async function GET(
  request: Request,
  context: { params: { path: string[] } }
) {
  return proxyRequest(request, context);
}

export async function POST(
  request: Request,
  context: { params: { path: string[] } }
) {
  return proxyRequest(request, context);
}

export async function PUT(
  request: Request,
  context: { params: { path: string[] } }
) {
  return proxyRequest(request, context);
}

export async function PATCH(
  request: Request,
  context: { params: { path: string[] } }
) {
  return proxyRequest(request, context);
}

export async function DELETE(
  request: Request,
  context: { params: { path: string[] } }
) {
  return proxyRequest(request, context);
}
