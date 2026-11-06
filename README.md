# Computer House Storefront

![Next.js](https://img.shields.io/badge/Next.js-black?style=for-the-badge&logo=next.js&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=FastAPI&logoColor=white)
![Redis](https://img.shields.io/badge/redis-%23DD0031.svg?style=for-the-badge&logo=redis&logoColor=white)
![Celery](https://img.shields.io/badge/celery-%2337814A.svg?style=for-the-badge&logo=celery&logoColor=white)
![Nginx](https://img.shields.io/badge/nginx-%23009639.svg?style=for-the-badge&logo=nginx&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white)
![Docker](https://img.shields.io/badge/docker-%230db7ed.svg?style=for-the-badge&logo=docker&logoColor=white)

A high-performance, production-ready e-commerce storefront for custom PCs and hardware components. Designed with a decoupled microservices architecture, asynchronous background processing, and enterprise-grade fault tolerance.

## Tech Stack

### Frontend
* **Next.js 16**: App Router, Turbopack, and Server-Side Rendering (SSR).
* **React & Tailwind CSS**: For a responsive, modern UI.
* **TypeScript**: Strict type checking for UI components and API contracts.

### Backend
* **FastAPI**: High-performance asynchronous REST API.
* **Python 3.11 & Pydantic**: Strict data validation and schema enforcement.
* **Celery**: Distributed task queue for background processing.

### Data & Infrastructure
* **Supabase (PostgreSQL)**: Relational database with strict foreign-key constraints.
* **Redis**: In-memory message broker for Celery and state caching.
* **Nginx**: Web server and reverse proxy.
* **Docker & Docker Compose**: Containerization, multi-stage builds, and isolated network layers.

---

## Architecture

### 1. Backend Architecture
The backend is completely decoupled from the frontend, operating as a headless API. 
* **API Layer**: FastAPI exposes endpoints (e.g., `/api/orders`) handling strictly validated UUIDs and idempotency keys. 
* **Database Layer**: Directly integrated with Supabase. Relational integrity is enforced at the database level (e.g., checking customer UUIDs before inserting order items).
* **Worker Layer**: Celery workers subscribe to Redis queues. Once an order is safely committed to PostgreSQL, FastAPI dispatches asynchronous tasks (WhatsApp notifications, dropshipper forwarding) to Celery, allowing the API to return a `201 Created` response instantly.

### 2. DevOps & Networking Architecture
* **Isolated Container Networks**: Services communicate over an internal Docker network (`app_network`). The FastAPI backend, Redis, and Celery are not exposed to the public internet directly.
* **Nginx as an Edge Router**: 
  * Serves Next.js static assets (`/_next/static/`) directly from shared disk volumes with heavy `Cache-Control`.
  * Proxies dynamic frontend rendering to the Next.js standalone container.
  * Proxies `/api/*` requests internally to the FastAPI container, mapping client-side routes (e.g., `/api/checkout`) to backend controllers (`/api/orders`).
* **Multi-Stage Builds**: The Next.js `Dockerfile` compiles the application down to a minimal `standalone` output, discarding all build dependencies to reduce image size and minimize the security attack surface.

---

## High Availability (HA) & Fault Tolerance (FT)

This system is engineered to survive network drops, API rate limits, and concurrent user race conditions:

1. **Idempotency Keys**: Every checkout request requires a unique `Idempotency-Key` header. If a user clicks "Submit" multiple times or the network drops during the response, the system catches the duplicate key and prevents double-billing or duplicate database entries.
2. **Asynchronous Resilience (Celery Backoff & Jitter)**: Background tasks (like external WhatsApp API calls) are wrapped in transient error handlers. If the UltraMsg/WhatsApp API is down, Celery automatically retries the task using **exponential backoff** (waiting 2s, 4s, 8s, up to 5 minutes) and **jitter** (randomizing retry times to prevent thundering herd problems).
3. **Database Transactions**: Order insertions and order-item insertions are wrapped in atomic try-except blocks. If an order-item insertion fails due to a missing product ID, the entire order is rolled back to prevent orphaned records.
4. **Decoupled Failure Domains**: If the Redis broker crashes, the database and frontend stay up. If a Celery worker dies, Redis safely holds the unacknowledged tasks in memory until a new worker spins up to process them. 
5. **No Client-Side Pricing Trust**: Prices are calculated and verified on the server side against the database. The frontend only submits `product_id` and `quantity`.

---

## Deployment

To spin up the entire production environment:

# 1. Clone the repository
git clone [https://github.com/your-username/computer-house.git](https://github.com/your-username/computer-house.git)
cd computer-house

# 2. Configure Environment Variables
# Edit the .env file with your Supabase credentials and WhatsApp API tokens
nano .env

# 3. Build and Deploy
docker compose up --build -d
