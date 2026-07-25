# Project Overview: Newsletter Subscribers Management Dashboard

## Purpose

This project is a web-based dashboard for managing newsletter subscribers. It allows administrators to view, add, and remove subscribers, providing a user-friendly interface and secure backend API. The system is designed for extensibility and security, using modern technologies on both the frontend and backend.

---

## Frontend

- **Framework:** Vue.js 3 (with Vite)
- **Styling:** Tailwind CSS
- **Features:**
  - Responsive dashboard UI
  - Data table for listing subscribers (email, subscription date)
  - Remove subscriber action with confirmation
  - (Optional) Add subscriber, search, and pagination
- **API Integration:**
  - Fetches subscriber data from backend
  - Sends delete requests to backend
  - Handles authentication via JWT

---

## Backend

- **Framework:** Node.js with Express
- **Database:** MongoDB (native driver)
- **Authentication:** JWT-based
- **Structure:** Modular, with shared MongoDB connection utility

### Main Features

- User registration and login (with password hashing and JWT issuance)
- Protected routes for managing subscribers (CRUD)
- Public or protected route for adding subscribers
- Easily extensible for new features or data models

### Data Model

- **Collection:** `newsletter_subscribers`
- **Fields:**
  - `_id` (ObjectId, unique)
  - `email` (string, unique, required)
  - `subscribedAt` (date, required)

### API Endpoints

1. `POST /api/register` — Register a new admin user
2. `POST /api/login` — Login and receive JWT
3. `GET /api/newsletter-subscribers` — List all subscribers (protected)
4. `POST /api/newsletter-subscribers` — Add a subscriber (public or protected)
5. `DELETE /api/newsletter-subscribers/:id` — Remove a subscriber (protected)

#### Example API Response

```json
[
  {
    "id": "64c9f...",
    "email": "subscriber@email.com",
    "subscribedAt": "2025-07-30"
  }
]
```

---

## Authentication Flow

- Admin registers and logs in to receive a JWT
- JWT is sent in the `Authorization: Bearer <token>` header for protected routes
- Backend verifies JWT and grants access to protected resources

---

## Error Handling

- Returns appropriate HTTP status codes and error messages
- Handles duplicate emails, missing fields, unauthorized access, and not found errors

---

## Extensibility

- Backend is modular: new routes and models can be added easily
- Frontend can be extended for search, pagination, or analytics

---

## Security

- Passwords are hashed before storage
- JWT tokens are used for authentication
- Protected routes require valid JWT

---

## Example MongoDB Document

```json
{
  "_id": "64c9f...",
  "email": "subscriber@email.com",
  "subscribedAt": "2025-07-30T12:34:56.789Z"
}
```

---

## Summary

This project provides a secure, extensible, and user-friendly solution for managing newsletter subscribers, with a clear separation of concerns between the frontend and backend. The backend is ready to be adapted for additional features as required by the frontend.
