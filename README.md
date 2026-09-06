# CodeCollab

## Overview

CodeCollab is a real-time collaborative coding platform that allows multiple users to join a shared workspace and code together in real time. It enables seamless collaboration with instant code synchronization, making it suitable for pair programming, technical interviews, and collaborative learning.

The platform includes a built-in JavaScript code editor where users can write, compile, and execute code directly in the browser.

---

## Features

- Real-time collaborative code editing
- Multiple users can join the same coding room
- Live synchronization of code changes
- JavaScript code execution in the browser
- Authentication system with login and registration
- Room-based collaboration system
- Persistent user sessions
- Smooth and responsive editor experience

---

## Tech Stack

### Frontend
- React
- Monaco Editor 
- Socket.io Client

### Backend
- Node.js
- Express.js
- Socket.io

### Database
- MongoDB

### Collaboration Engine
- Yjs (CRDT-based real-time synchronization)

### Authentication
- JWT-based authentication (login and register system)

---

## Architecture

- React frontend communicates with backend via Socket.io
- Backend manages rooms and user connections
- Yjs handles conflict-free real-time text synchronization
- MongoDB stores user data and authentication details
- Express provides REST APIs for authentication and user management

---

## Installation

### Clone the repository

git clone https://github.com/ALANPRAFUL-A/CodeCollab.git


### Install dependencies

#### Backend

cd backend
npm install


#### Frontend

cd frontend
npm install


---

## Environment Variables

Create a `.env` file in the backend directory:


MONGO_URI = your_mongodb_connection_string
JWT_SECRET = secret_key
PORT = 5000


---

## Running the Project

### Start Backend

cd backend
npm start


### Start Frontend

cd frontend
npm run dev


---

---

## Running with Docker (full production-style stack)

The repository also ships a containerised stack that runs three load-balanced
backend replicas behind a reverse proxy, with a controlled egress path:

```
browser -> nginx reverse proxy -> HAProxy (least connections + sticky sessions)
             -> backend-1 / backend-2 / backend-3 -> MongoDB + Redis
                                                  -> Squid forward proxy -> internet
```

```bash
cd CodeCollab
cp .env.example .env        # then fill in the CHANGE_ME values
docker compose up -d --build
```

| | |
|---|---|
| App | <http://localhost:8080> |
| Load balancer dashboard | <http://localhost:8404> |
| Health | <http://localhost:8080/health> |

Full walkthrough, per-layer explanation and troubleshooting:
**[DOCKER_INFRA_GUIDE.md](./DOCKER_INFRA_GUIDE.md)**

Note that running more than one backend replica requires Redis (`REDIS_URL`),
which the Compose stack provides. Without it the server falls back to
single-instance mode and replicas cannot share editing sessions.

---

## Deployment

- Frontend can be deployed on Vercel or Netlify
- Backend can be deployed on Render
- Or deploy the whole stack with Docker Compose (see the guide above)
- Ensure environment variables are configured in deployment platforms

---

## Future Improvements

- Multi-language code support
- Voice chat during collaboration
- Role-based permissions (admin/editor/viewer)

---

## License

This project is open-source and available for learning and development purposes.
