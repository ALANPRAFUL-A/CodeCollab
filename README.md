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

## Deployment

- Frontend can be deployed on Vercel or Netlify
- Backend can be deployed on Render
- Ensure environment variables are configured in deployment platforms

---

## Future Improvements

- Multi-language code support
- Voice chat during collaboration
- Role-based permissions (admin/editor/viewer)

---

## License

This project is open-source and available for learning and development purposes.
