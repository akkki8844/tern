export const oldSpec = `openapi: 3.0.3
info:
  title: AcmePay API
  version: 1.0.0
paths:
  /v1/charges/{chargeId}:
    post:
      operationId: createCharge
      parameters:
        - in: path
          name: chargeId
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount]
              properties:
                amount: { type: number }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  statusText: { type: string }
`;

export const newSpec = `openapi: 3.0.3
info:
  title: AcmePay API
  version: 2.0.0
paths:
  /v2/payments/{paymentId}:
    post:
      operationId: createPayment
      parameters:
        - in: path
          name: paymentId
          required: true
          schema: { type: string }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, currency]
              properties:
                amount: { type: number }
                currency: { type: string }
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  state: { type: string }
`;
