# Backend Production Deployment Guide (AWS EC2 & S3)

This guide details the complete production deployment procedure for the Self-Destructing File Sharing backend service on AWS EC2, configured with Nginx reverse proxy, SSL (Let's Encrypt / Certbot), private S3 bucket configuration, and least-privilege IAM policies.

---

## 1. Architecture Overview

- **Compute**: AWS EC2 instance (Ubuntu 24.04 LTS / 22.04 LTS, `t3.small` or `t3.medium`).
- **Container**: Multi-stage Docker container running as non-root user (`appuser:10001`).
- **Reverse Proxy**: Nginx with SSL termination via Certbot.
- **Object Storage**: AWS S3 (private bucket with all public access blocked).
- **Direct Transfers**: Browser transfers directly to S3 via pre-signed PUT/GET URLs. Payload bytes bypass EC2 entirely.

---

## 2. AWS S3 & IAM Configuration

### 2.1 Private S3 Bucket Setup
1. Create a dedicated S3 bucket, e.g., `my-company-file-share-prod`.
2. **Block Public Access**: Enable all 4 settings under "Block public access (bucket settings)":
   - [x] Block public ACLs
   - [x] Ignore public ACLs
   - [x] Block public bucket policies
   - [x] Restrict public bucket policies

### 2.2 S3 CORS Configuration
Since web clients upload and download directly to/from S3, configure Cross-Origin Resource Sharing (CORS) on the bucket:

```json
[
  {
    "AllowedHeaders": [
      "*"
    ],
    "AllowedMethods": [
      "PUT",
      "GET",
      "HEAD"
    ],
    "AllowedOrigins": [
      "https://share.example.com"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3000
  }
]
```

### 2.3 Least-Privilege IAM Policy
Attach the following IAM policy to the EC2 Instance Profile (IAM Role) running the backend:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FileSharingServiceS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:HeadObject"
      ],
      "Resource": "arn:aws:s3:::my-company-file-share-prod/*"
    }
  ]
}
```

---

## 3. EC2 Host Preparation

### 3.1 Install Docker & Docker Compose
Connect via SSH to your EC2 instance and execute:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# Add Docker GPG key
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo \
  "deb [arch="$(dpkg --print-architecture)" signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  "$(. /etc/os-release && echo "$VERSION_CODENAME")" stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Grant ubuntu user docker access
sudo usermod -aG docker ubuntu
newgrp docker
```

---

## 4. Environment Variables Configuration

Create `/opt/file-share/backend/.env` on the host:

```bash
sudo mkdir -p /opt/file-share/backend/data
sudo chown -R 10001:10001 /opt/file-share/backend/data
```

Populate `/opt/file-share/backend/.env`:

```env
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

# SQLite Database (persisted via Docker volume)
DATABASE_PATH=/app/data/metadata.db

# AWS S3 Production Storage (Uses IAM Instance Profile or explicit keys)
S3_REGION=us-east-1
S3_BUCKET=my-company-file-share-prod
S3_FORCE_PATH_STYLE=false
# Leave AWS_ACCESS_KEY_ID & AWS_SECRET_ACCESS_KEY empty when using EC2 IAM Role

# Upload & App Configuration
MAX_FILE_MB=1024
BASE_URL=https://share.example.com
GRANT_TOKEN_SECRET=generate-a-strong-64-character-random-hex-secret
CLEANUP_CRON_SCHEDULE=*/5 * * * *
```

---

## 5. Nginx Reverse Proxy & SSL (Certbot)

### 5.1 Install Nginx & Certbot
```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

### 5.2 Configure Nginx Server Block
Create `/etc/nginx/sites-available/file-share`:

```nginx
server {
    server_name api.example.com;

    # Payload bytes never pass through Nginx, so keep client body size modest
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable configuration and issue SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/file-share /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# Issue Let's Encrypt Certificate
sudo certbot --nginx -d api.example.com
```

---

## 6. Docker Container Execution

### 6.1 Build and Run Production Image
From the repository root:

```bash
docker build -t file-share-backend:latest ./backend

docker run -d \
  --name file-share-api \
  --restart unless-stopped \
  --env-file /opt/file-share/backend/.env \
  -v /opt/file-share/backend/data:/app/data \
  -p 127.0.0.1:3000:3000 \
  file-share-backend:latest
```

### 6.2 Health & Status Verification
```bash
docker ps
curl http://localhost:3000/health
```
Output:
```json
{"status":"ok","timestamp":"2026-11-01T12:00:00.000Z"}
```

