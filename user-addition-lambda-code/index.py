import os
import sys
sys.path.append('/opt/python')
import psycopg2
import json

def lambda_handler(event, context):
    # Extract environment variables
    db_host = os.environ['DB_HOST']
    db_user = os.environ['DB_USER']
    db_password = os.environ['DB_PASSWORD']
    db_name = os.environ['DB_NAME']
    connection = None

    try:
        # Extract username and email from the event
        username = event.get('username')
        email = event.get('email')

        if not username or not email:
            raise ValueError("Required fields username or email are missing in the event data.")

        # Connect to the PostgreSQL database
        connection = psycopg2.connect(
            host=db_host,
            user=db_user,
            password=db_password,
            dbname=db_name
        )
        cursor = connection.cursor()

        # Create the user table if it does not exist
        create_table_query = """
            CREATE TABLE IF NOT EXISTS "users" (
                id SERIAL PRIMARY KEY,
                "username" VARCHAR NOT NULL,
                email VARCHAR NOT NULL
            )
        """
        cursor.execute(create_table_query)

        # Insert user data into the table
        insert_query = """
            INSERT INTO "users" ("username", email)
            VALUES (%s, %s)
        """
        cursor.execute(insert_query, (username, email))
        connection.commit()

        print(f"User {username} with email {email} added successfully.")
        return {
            "statusCode": 200,
            "body": json.dumps({"message": f"User {username} added successfully."})
        }
    except Exception as e:
        print(f"Error: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"error": str(e)})
        }
    finally:
        if connection:
            cursor.close()
            connection.close()
